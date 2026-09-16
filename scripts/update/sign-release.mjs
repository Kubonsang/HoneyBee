import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { open } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { loadProtectedReleaseKey } from "./release-key.mjs";
import { readBounded } from "./prepare-release.mjs";
import { authenticateReleaseManifest, signReleaseManifest } from "./release-authentication.mjs";

const [manifestPath, privateKeyPath, publicKeyPath, outputPath] = process.argv.slice(2);
assert(
  manifestPath && privateKeyPath && publicKeyPath && outputPath,
  "Usage: sign-release.mjs <release.json> <private-key.pem|external-key.dpapi> <approved-public-key.pem> <new-signature-path>",
);
const manifest = await readBounded(manifestPath, 64 * 1024);
let key;
if (path.extname(privateKeyPath) === ".dpapi") {
  key = await loadProtectedReleaseKey(privateKeyPath);
} else {
  const keyBytes = await readBounded(privateKeyPath, 64 * 1024);
  try {
    key = createPrivateKey(keyBytes);
  } finally {
    keyBytes.fill(0);
  }
}
const signature = signReleaseManifest(manifest, key);
const approved = await readBounded(publicKeyPath, 64 * 1024);
const verified = authenticateReleaseManifest(manifest, signature, [approved]);
const file = await open(outputPath, "wx", 0o600);
try {
  await file.writeFile(signature);
  await file.sync();
} finally {
  await file.close();
}
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    manifestSha256: verified.manifestSha256,
    signerKeyId: verified.signerKeyId,
  }) + "\n",
);
