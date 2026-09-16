import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  recoveryInventoryBytes,
  persistRecoverySource,
  resolveRecoverySource,
  verifyRecoverySourceFiles,
} from "./recovery-source.mjs";
import { authenticateReleaseManifest, signReleaseManifest } from "./release-authentication.mjs";
import { sha256 } from "./release-manifest.mjs";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
async function fixture() {
  const parent = path.resolve("output/recovery-source-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-")),
    runtime = path.join(root, "recovery/v1");
  await mkdir(runtime, { recursive: true });
  const initial = {
    schemaVersion: 1,
    version: "0.1.0-beta.11",
    launchSha256: sha256("initial"),
    files: {},
  };
  await writeFile(path.join(runtime, "approved-source.json"), JSON.stringify(initial));
  await writeFile(
    path.join(runtime, "update-trust.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: "beta",
      bootstrapperVersion: "1.0.0",
      publicKeys: [publicKey],
    }),
  );
  await writeFile(path.join(root, "current.json"), "preserve pointer");
  return { root, runtime, initial };
}
async function release(f, version = "0.1.0-beta.12") {
  const files = {
    "launch.json": JSON.stringify({ version }),
    "installation.json": JSON.stringify({ activity: { protocol: 1 } }),
    "runtime/node.exe": "node",
    "desktop/HoneyBee.exe": "desktop",
    "cli/dist/cli.js": "cli",
  };
  const inventory = Object.fromEntries(
    Object.entries(files).map(([name, data]) => [
      name,
      { size: Buffer.byteLength(data), sha256: sha256(data) },
    ]),
  );
  const inventoryBytes = recoveryInventoryBytes(inventory),
    launchManifestSha256 = inventory["launch.json"].sha256;
  const manifest = {
    schemaVersion: 1,
    version,
    channel: "beta",
    mandatory: false,
    minimumSourceVersion: "0.1.0-beta.11",
    minimumBootstrapperVersion: "1.0.0",
    packages: {
      application: {
        url: "https://github.com/Kubonsang/HoneyBee/releases/download/v12/application.zip",
        sha256: sha256("zip"),
        size: 3,
        format: "zip",
      },
    },
    components: {
      desktop: { version, package: "application" },
      cli: { version, package: "application" },
      storage: {
        componentVersion: "test.hb12",
        package: "application",
        migration: { kind: "none", supportedSourceVersions: ["test.hb12"] },
      },
    },
    recovery: { schemaVersion: 1, inventorySha256: sha256(inventoryBytes), launchManifestSha256 },
  };
  const bytes = Buffer.from(JSON.stringify(manifest)),
    signature = signReleaseManifest(bytes, keys.privateKey);
  const authenticated = authenticateReleaseManifest(bytes, signature, [publicKey]);
  await persistRecoverySource({ installationRoot: f.root, authenticated, inventoryBytes });
  const directory = path.join(f.root, "versions", version);
  for (const [name, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), data);
  }
  return {
    pointer: { activeVersion: version, manifestSha256: launchManifestSha256 },
    directory,
    proof: path.join(f.root, "update/recovery-sources", version),
  };
}
test("successive signed sources remain recoverable without changing the runtime pin", async () => {
  const f = await fixture(),
    initialBytes = await readFile(path.join(f.runtime, "approved-source.json"));
  for (const version of ["0.1.0-beta.12", "0.1.0-beta.13"]) {
    const r = await release(f, version);
    const approved = await resolveRecoverySource({
      installationRoot: f.root,
      runtime: f.runtime,
      pointer: r.pointer,
    });
    await verifyRecoverySourceFiles(f.root, approved);
    assert.equal(approved.version, version);
  }
  assert.deepEqual(await readFile(path.join(f.runtime, "approved-source.json")), initialBytes);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), "preserve pointer");
});
for (const failure of [
  "signature",
  "inventory",
  "launch-pin",
  "extra-file",
  "payload",
  "missing-proof",
  "untrusted-key",
])
  test(`signed recovery refuses ${failure}`, async () => {
    const f = await fixture(),
      r = await release(f);
    if (failure === "signature") await writeFile(path.join(r.proof, "release.sig.json"), "{}");
    if (failure === "inventory")
      await writeFile(
        path.join(r.proof, "inventory.json"),
        JSON.stringify({ schemaVersion: 1, files: {} }),
      );
    if (failure === "launch-pin") r.pointer.manifestSha256 = sha256("changed");
    if (failure === "extra-file")
      await writeFile(path.join(r.directory, "extra.dll"), "unexpected");
    if (failure === "payload")
      await writeFile(path.join(r.directory, "runtime/node.exe"), "changed");
    if (failure === "missing-proof") await unlink(path.join(r.proof, "release.sig.json"));
    if (failure === "untrusted-key")
      await writeFile(
        path.join(f.runtime, "update-trust.json"),
        JSON.stringify({
          schemaVersion: 1,
          channel: "beta",
          bootstrapperVersion: "1.0.0",
          publicKeys: [],
        }),
      );
    await assert.rejects(async () => {
      const approved = await resolveRecoverySource({
        installationRoot: f.root,
        runtime: f.runtime,
        pointer: r.pointer,
      });
      await verifyRecoverySourceFiles(f.root, approved);
    });
    assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), "preserve pointer");
  });
test("initial source approval remains usable without signed-release metadata", async () => {
  const f = await fixture();
  await unlink(path.join(f.runtime, "update-trust.json"));
  assert.deepEqual(
    await resolveRecoverySource({
      installationRoot: f.root,
      runtime: f.runtime,
      pointer: { activeVersion: f.initial.version, manifestSha256: f.initial.launchSha256 },
    }),
    f.initial,
  );
});
test("canonical inventory is order independent and rejects aliased or escaping paths", () => {
  const entry = { size: 1, sha256: sha256("x") };
  assert.deepEqual(
    recoveryInventoryBytes({ b: entry, a: entry }),
    recoveryInventoryBytes({ a: entry, b: entry }),
  );
  for (const files of [{ "../x": entry }, { a: entry, A: entry }, { "C:/x": entry }])
    assert.throws(() => recoveryInventoryBytes(files));
});
