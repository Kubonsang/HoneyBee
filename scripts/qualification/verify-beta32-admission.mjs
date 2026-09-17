import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const base = path.resolve("output/acceptance-completion-20260916");
const evidence = await mkdtemp(path.join(base, "admission-"));
const installation = path.resolve(
  "output/two-version-qa/build-5UuH8o/output/installations/0.1.0-beta.32-0h5HGV/HoneyBee",
);
const distribution = path.resolve(
  "output/final-release-builds/build-FXg9Xs/distributions/distribution-vPVNDj",
);
const runtime = path.join(installation, "recovery/v1");
const version = path.join(installation, "versions/0.1.0-beta.32");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const load = async (name) => JSON.parse(await readFile(name, "utf8"));
const results = [];
const check = async (name, operation) => {
  await operation();
  results.push({ name, passed: true });
};
try {
  const setupSha256 = sha(await readFile(path.join(distribution, "HoneyBeeSetup.exe")));
  assert.equal(setupSha256, "8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e");
  const inventoryBytes = await readFile(path.join(runtime, "manifest.json"));
  assert.equal(
    sha(inventoryBytes),
    "454e376271bcd6a52e98d3334d7efc2410e691289ec1536699f0f0c0675fe9f2",
  );
  const inventory = JSON.parse(inventoryBytes);
  for (const [name, digest] of Object.entries(inventory.files)) {
    assert.equal(sha(await readFile(path.join(runtime, name))), digest, name);
    if (name.startsWith("packages/core/dist/") && name.endsWith(".js"))
      assert.equal(
        sha(
          await readFile(
            path.join(version, "cli/node_modules/@honeybee/core/dist", path.basename(name)),
          ),
        ),
        digest,
        `CLI copy ${name}`,
      );
  }
  const { authenticateReleaseManifest } = await import(
    pathToFileURL(path.join(runtime, "scripts/update/release-authentication.mjs"))
  );
  const { admitRelease } = await import(
    pathToFileURL(path.join(runtime, "scripts/update/release-manifest.mjs"))
  );
  const { inspectCompatibleStorage } = await import(
    pathToFileURL(path.join(runtime, "packages/core/dist/workspace-storage-adoption.js"))
  );
  const { planStorageUpdate } = await import(
    pathToFileURL(path.join(runtime, "packages/core/dist/workspace-storage-update.js"))
  );
  const trust = await load(path.join(runtime, "update-trust.json"));
  const manifestBytes = await readFile(path.join(distribution, "release.json"));
  const signatureBytes = await readFile(path.join(distribution, "release.sig.json"));
  const authenticated = authenticateReleaseManifest(
    manifestBytes,
    signatureBytes,
    trust.publicKeys,
  );
  assert.equal(
    authenticated.manifestSha256,
    "43fdd39e04c0d4a34bd5b0b92ead99e5044e2d41df82548621acd79741f2a9d3",
  );
  const manifest = authenticated.manifest;
  const metadata = await load(path.join(version, "installation.json"));
  const tools = {
    provenance: "managed",
    expectedComponentVersion: metadata.componentVersion,
    expectedClientSha256: metadata.clientSha256,
    expectedControlSha256: metadata.controlSha256,
    clientCommand: path.join(version, "tools/unity-workspace-storage.exe"),
    controlCommand: path.join(version, "tools/honeybee-workspace-storage-host.exe"),
  };
  assert.equal(sha(await readFile(tools.clientCommand)), metadata.clientSha256);
  assert.equal(sha(await readFile(tools.controlCommand)), metadata.controlSha256);
  assert.equal(metadata.componentVersion, manifest.components.storage.componentVersion);
  const source = {
    currentVersion: "0.1.0-beta.31",
    bootstrapperVersion: trust.bootstrapperVersion,
    channel: trust.channel,
    storageComponentVersion: metadata.componentVersion,
  };
  await check("authenticated compatible release admitted", () => admitRelease(manifest, source));
  for (const [name, change, message] of [
    ["source floor", { currentVersion: "0.1.0-beta.30" }, /Source version too old/u],
    ["bootstrapper floor", { bootstrapperVersion: "0.0.9" }, /Bootstrapper upgrade required/u],
    ["channel mismatch", { channel: "stable" }, /Channel mismatch/u],
    ["same-version refusal", { currentVersion: "0.1.0-beta.32" }, /Release is not newer/u],
    ["downgrade refusal", { currentVersion: "0.1.0-beta.33" }, /Release is not newer/u],
    [
      "older service refusal",
      { storageComponentVersion: "0.0.0+cfa606fd4143.hb12" },
      /Unsupported storage source/u,
    ],
    [
      "newer unsupported service refusal",
      { storageComponentVersion: "0.0.0+cfa606fd4143.hb14" },
      /Unsupported storage source/u,
    ],
  ])
    await check(name, () =>
      assert.throws(() => admitRelease(manifest, { ...source, ...change }), message),
    );
  const diagnostic = {
    serviceExists: true,
    serviceState: "running",
    receiptExists: true,
    receiptValid: true,
    executableExists: true,
    executableDigestMatches: true,
    userMatches: true,
    workspaceRootAccessible: true,
    componentVersion: metadata.componentVersion,
  };
  const port = (componentVersion) => ({
    diagnose: async () => ({ ...diagnostic, componentVersion }),
    status: async () => ({ parentCount: 1, manualRecoveryRequired: false }),
  });
  await check("compiled service compatibility positive control", () =>
    inspectCompatibleStorage(port(metadata.componentVersion), tools),
  );
  for (const component of ["0.0.0+cfa606fd4143.hb12", "0.0.0+cfa606fd4143.hb14"]) {
    await check(`compiled compatibility refuses ${component}`, () =>
      assert.rejects(inspectCompatibleStorage(port(component), tools), {
        code: "storage.installation-not-ready",
      }),
    );
    await check(`planner refuses unsupported source ${component} before native probe`, async () => {
      const blocked = await planStorageUpdate(
        {},
        { ...tools, expectedComponentVersion: component },
        manifest.components.storage,
      );
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.reason, "unsupported-storage-transition");
      assert.equal(blocked.activationAllowed, false);
    });
  }
  await check("tampered manifest refused", () =>
    assert.throws(
      () =>
        authenticateReleaseManifest(
          Buffer.from(manifestBytes.toString().replace('"mandatory": false', '"mandatory": true')),
          signatureBytes,
          trust.publicKeys,
        ),
      /Signed manifest digest mismatch/u,
    ),
  );
  await check("untrusted signer refused", () =>
    assert.throws(
      () =>
        authenticateReleaseManifest(manifestBytes, signatureBytes, [
          generateKeyPairSync("ed25519").publicKey,
        ]),
      /Untrusted release signer/u,
    ),
  );
  await check("damaged signature refused", () => {
    const metadata = JSON.parse(signatureBytes);
    const bytes = Buffer.from(metadata.signature, "base64");
    bytes[0] ^= 1;
    metadata.signature = bytes.toString("base64");
    assert.throws(
      () =>
        authenticateReleaseManifest(
          manifestBytes,
          Buffer.from(JSON.stringify(metadata)),
          trust.publicKeys,
        ),
      /Release signature verification failed/u,
    );
  });
  const report = {
    schemaVersion: 1,
    passed: true,
    candidate: { setupSha256, manifestSha256: authenticated.manifestSha256 },
    results,
    evidence,
    recoveryInventorySha256: sha(inventoryBytes),
    inventoryFilesVerified: Object.keys(inventory.files).length,
    controlSha256: metadata.controlSha256,
    scope:
      "Exact shipped JS/compiled-core boundary checks with diagnostic fixtures; no live incompatible service installed or native mismatch execution",
    acceptancePromoted: false,
  };
  await writeFile(path.join(evidence, "result.json"), JSON.stringify(report, null, 2), {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ passed: true, checks: results.length, evidence })}\n`);
} catch (error) {
  await writeFile(
    path.join(evidence, "failed.json"),
    JSON.stringify({ passed: false, error: error.stack, results }, null, 2),
    { flag: "wx" },
  );
  throw error;
}
