import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPrivateKey } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";
import { loadProtectedReleaseKey } from "./release-key.mjs";
import { readBounded } from "./prepare-release.mjs";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import {
  authenticateSetupDescriptor,
  signSetupDescriptor,
  setupAssetUrl,
} from "./setup-descriptor.mjs";

const [
  setupPath,
  manifestPath,
  manifestSignaturePath,
  privateKeyPath,
  publicKeyPath,
  outputDirectory,
] = process.argv.slice(2);
assert(
  process.argv.length === 8,
  "Usage: sign-setup.mjs <Setup.exe> <release.json> <release.sig.json> <private-key.pem|key.dpapi> <approved-public-key.pem> <existing-output-directory>",
);
const approved = await readBounded(publicKeyPath, 65536);
const release = authenticateReleaseManifest(
  await readBounded(manifestPath, 65536),
  await readBounded(manifestSignaturePath, 4096),
  [approved],
);
const setup = await digestDistributionFile(setupPath);
const bytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    version: release.manifest.version,
    manifestSha256: release.manifestSha256,
    setup: { url: setupAssetUrl(release.manifest.version, "HoneyBeeSetup.exe"), ...setup },
  }) + "\n",
);
let key;
if (path.extname(privateKeyPath) === ".dpapi") key = await loadProtectedReleaseKey(privateKeyPath);
else {
  const secret = await readBounded(privateKeyPath, 65536);
  try {
    key = createPrivateKey(secret);
  } finally {
    secret.fill(0);
  }
}
const signature = signSetupDescriptor(bytes, key);
const authenticated = authenticateSetupDescriptor(bytes, signature, [approved], release);
assert.deepEqual(await digestDistributionFile(setupPath), setup, "Setup changed during signing");
for (const [name, content] of [
  ["setup.json", bytes],
  ["setup.sig.json", signature],
]) {
  const file = await open(path.join(outputDirectory, name), "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
process.stdout.write(
  JSON.stringify({
    version: release.manifest.version,
    descriptorSha256: authenticated.descriptorSha256,
    setupSha256: setup.sha256,
  }) + "\n",
);
