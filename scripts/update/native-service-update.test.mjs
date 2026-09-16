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
