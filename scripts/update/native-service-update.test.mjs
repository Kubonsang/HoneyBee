import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";
import { createNativeServiceUpdate } from "./native-service-update.mjs";

const legacyBridgeOptions = () => ({
  installationRoot: path.resolve("output/legacy-bridge-validation"),
  identity: {
    serviceTransactionSha256: "a".repeat(64),
    sourcePointerSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  },
  targetPointerSha256: "d".repeat(64),
  sourceRecovery: "legacy-hb12-detached",
  sourceObservationSha256: "e".repeat(64),
});
const legacyBaseline = () => ({
  schemaVersion: 1,
  kind: "legacy-source-baseline",
  version: "0.1.0-beta.35",
  baselineRestored: true,
  ready: false,
  readyForWorkspaceOperations: false,
  activationAllowed: false,
  sourceEvidenceSha256: "e".repeat(64),
});

test("failed target diagnostics survive rollback without becoming commit evidence", async () => {
  const options = legacyBridgeOptions();
  options.installationRoot = await mkdtemp(path.join(os.tmpdir(), "hb-failed-health-"));
  const checked = {
    ready: false,
    failure: { code: "update.health-failed", message: "diagnostic transport failed" },
  };
  const bridge = createNativeServiceUpdate(options, {
    health: async () => checked,
    sessionFactory: () => assert.fail("failed health cannot request commit"),
  });
  assert.equal(await bridge.validateDoctor(), false);
  const directory = path.join(
    options.installationRoot,
    "update/service-contexts",
    options.identity.serviceTransactionSha256,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(directory, `failed-health-${sha256(JSON.stringify(checked))}.json`)),
    ),
    checked,
  );
  await assert.rejects(readFile(path.join(directory, "doctor.json")), { code: "ENOENT" });
});

test("explicit legacy rollback accepts only its bound unready baseline; target still requires Doctor", async () => {
  const options = legacyBridgeOptions();
  const bridge = createNativeServiceUpdate(options, {
    health: async () => legacyBaseline(),
    sessionFactory: () => {
      throw new Error("validation cannot open a privileged session");
    },
  });
  assert.equal(await bridge.validateSource(), true);
  assert.equal(await bridge.validateDoctor(), false);
  // Caller mutation cannot turn this validation into the ordinary ready test.
  options.sourceRecovery = undefined;
  options.sourceObservationSha256 = "f".repeat(64);
  assert.equal(await bridge.validateSource(), true);
  const ordinary = { ...legacyBridgeOptions() };
  Reflect.deleteProperty(ordinary, "sourceRecovery");
  Reflect.deleteProperty(ordinary, "sourceObservationSha256");
  assert.equal(
    await createNativeServiceUpdate(ordinary, {
      health: async () => legacyBaseline(),
    }).validateSource(),
    false,
  );
});

for (const [field, value] of Object.entries({
  schemaVersion: 2,
  kind: "doctor",
  version: "0.1.0-beta.36",
  baselineRestored: false,
  ready: true,
  readyForWorkspaceOperations: true,
  activationAllowed: true,
  sourceEvidenceSha256: "f".repeat(64),
})) {
  test(`legacy rollback refuses changed baseline ${field}`, async () => {
    const bridge = createNativeServiceUpdate(legacyBridgeOptions(), {
      health: async () => ({ ...legacyBaseline(), [field]: value }),
    });
    assert.equal(await bridge.validateSource(), false);
  });
}

test("native source validation rejects unknown or unbound recovery intent", () => {
  for (const change of [
    { sourceRecovery: "unknown" },
    { sourceObservationSha256: undefined },
    { sourceRecovery: undefined },
  ]) {
    assert.throws(() =>
      createNativeServiceUpdate(
        { ...legacyBridgeOptions(), ...change },
        { health: async () => ({ ready: true }) },
      ),
    );
  }
});

test("legacy recovery lookup binds intent and source observation to protected native context", async () => {
  for (const scenario of [
    "valid",
    "missing-mode",
    "changed-mode",
    "missing-observation",
    "changed-observation",
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "hb-legacy-lookup-"));
    const options = { ...legacyBridgeOptions(), installationRoot: root, recover: true };
    const registration = {
      transactionSha256: options.identity.serviceTransactionSha256,
      contextSha256: "f".repeat(64),
      executableSha256: "a".repeat(64),
      executable: path.join(root, "protected-host.exe"),
    };
    const binding = {
      applicationRoot: root,
      sourcePointerSha256: options.identity.sourcePointerSha256,
      targetPointerSha256: options.targetPointerSha256,
      manifestSha256: options.identity.manifestSha256,
      sourceRecovery: options.sourceRecovery,
      sourceObservationSha256: options.sourceObservationSha256,
    };
    if (scenario === "missing-mode") Reflect.deleteProperty(binding, "sourceRecovery");
    if (scenario === "changed-mode") binding.sourceRecovery = "unknown";
    if (scenario === "missing-observation")
      Reflect.deleteProperty(binding, "sourceObservationSha256");
    if (scenario === "changed-observation") binding.sourceObservationSha256 = "f".repeat(64);
    const bridge = createNativeServiceUpdate(options, {
      health: async () => legacyBaseline(),
      sessionFactory: () => ({
        close: async () => {},
        request: async ({ operation }) => {
          assert.equal(operation, "lookup");
          return { state: "Prepared", registration, binding };
        },
      }),
    });
    const admit = bridge.admit({
      ...options.identity,
      identitySha256: combinedUpdateIdentity(options.identity),
    });
    if (scenario === "valid") await admit;
    else await assert.rejects(admit, /belongs to another application pair/u);
    await bridge.close();
  }
});

test("native adapters connect prepare, Doctor evidence and pair commit through one session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-native-bridge-"));
  const source = Buffer.from("source-pointer"),
    manifest = Buffer.from("signed-manifest");
  const identity = {
    serviceTransactionSha256: "a".repeat(64),
    sourcePointerSha256: sha256(source),
    manifestSha256: sha256(manifest),
  };
  const registration = {
    transactionSha256: identity.serviceTransactionSha256,
    contextSha256: "b".repeat(64),
    executableSha256: "c".repeat(64),
    executable: path.join(root, "protected-host.exe"),
  };
  let state = "Prepared",
    selection = "source",
    sessions = 0;
  const commands = [];
  const options = {
    installationRoot: root,
    identity,
    targetPointerSha256: "d".repeat(64),
    executable: path.join(root, "host.exe"),
    admission: {
      transactionSha256: identity.serviceTransactionSha256,
      applicationRoot: root,
      sourcePointer: source.toString("base64"),
      manifest: manifest.toString("base64"),
      ownerPid: process.pid,
    },
  };
  const report = { ready: true, marker: "real Doctor result fixture" };
  const hooks = {
    health: async () => ({ ready: true, report }),
    sessionFactory() {
      sessions++;
      return {
        close: async () => {},
        request: async (request) => {
          commands.push(request);
          if (request.operation === "stage")
            return {
              state,
              registration,
              binding: {
                applicationRoot: root,
                sourcePointerSha256: identity.sourcePointerSha256,
                targetPointerSha256: options.targetPointerSha256,
                manifestSha256: identity.manifestSha256,
              },
            };
          assert.equal(request.contextSha256, registration.contextSha256);
          if (request.operation === "prepare") state = "ReadyForAppCommit";
          if (request.operation === "commit") {
            assert.equal(request.desktopValidationId, combinedUpdateIdentity(identity));
            assert.equal(request.doctorSha256, sha256(Buffer.from(JSON.stringify(report) + "\n")));
            state = "Committed";
          }
          return { state, selection };
        },
      };
    },
  };
  const bridge = createNativeServiceUpdate(options, hooks);
  await bridge.admit({ ...identity, identitySha256: combinedUpdateIdentity(identity) });
  await bridge.prepareService();
  selection = "target";
  assert.equal(await bridge.authorizeCandidate(), true);
  await assert.rejects(bridge.commitPair(), { code: "ENOENT" });
  assert.equal(await bridge.validateDoctor(), true);
  await bridge.commitPair();
  assert.equal(await bridge.verifyCommitted(), true);
  await bridge.close();
  assert.equal(sessions, 1);
  assert.deepEqual(
    commands.map((c) => c.operation),
    ["stage", "prepare", "status", "commit", "status"],
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(
          root,
          "update/service-contexts",
          identity.serviceTransactionSha256,
          "native.json",
        ),
      ),
    ),
    registration,
  );
});

test("startup recovers registration from native authority, never a fabricated user receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-native-lookup-"));
  const identity = {
    serviceTransactionSha256: "a".repeat(64),
    sourcePointerSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const bridge = createNativeServiceUpdate(
    {
      installationRoot: root,
      identity,
      targetPointerSha256: "d".repeat(64),
      executable: path.join(root, "host.exe"),
      recover: true,
    },
    {
      health: async () => ({ ready: true }),
      sessionFactory: () => ({
        close: async () => {},
        request: async ({ operation }) => {
          assert.equal(operation, "lookup");
          return { state: "NotFound" };
        },
      }),
    },
  );
  await assert.rejects(
    bridge.admit({ ...identity, identitySha256: combinedUpdateIdentity(identity) }),
    /transaction is missing/u,
  );
  await bridge.close();
});
