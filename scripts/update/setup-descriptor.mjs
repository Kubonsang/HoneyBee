import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPublicKey, sign, verify } from "node:crypto";
import {
  compareVersions,
  maxPackageBytes,
  sha256,
  validateDownloadUrl,
} from "./release-manifest.mjs";

const context = Buffer.from("HoneyBee Setup descriptor signature v1\n");
const fields = (value, keys) => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "Unexpected Setup descriptor fields",
  );
};
const digest = (value) => assert(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
export const requiresSetupDescriptor = (version) => compareVersions(version, "0.1.0-beta.40") >= 0;
export const setupAssetUrl = (version, name) => {
  compareVersions(version, "0.0.0");
  assert(
    [
      "HoneyBeeSetup.exe",
      "setup.json",
      "setup.sig.json",
      "release.json",
      "release.sig.json",
    ].includes(name),
  );
  return `https://github.com/Kubonsang/HoneyBee/releases/download/v${version}/${name}`;
};

export function parseSetupDescriptor(bytes) {
  assert(bytes.byteLength <= 16384, "Setup descriptor exceeds limit");
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  fields(value, ["schemaVersion", "version", "manifestSha256", "setup"]);
  assert.equal(value.schemaVersion, 1);
  compareVersions(value.version, "0.0.0");
  digest(value.manifestSha256);
  fields(value.setup, ["url", "size", "sha256"]);
  digest(value.setup.sha256);
  assert(
    Number.isSafeInteger(value.setup.size) &&
      value.setup.size > 0 &&
      value.setup.size <= maxPackageBytes,
  );
  validateDownloadUrl(value.setup.url);
  assert.equal(value.setup.url, setupAssetUrl(value.version, "HoneyBeeSetup.exe"));
  return value;
}
const identity = (input) => {
  const key = input?.type === "public" ? input : createPublicKey(input);
  assert.equal(key.asymmetricKeyType, "ed25519");
  return { key, keyId: sha256(key.export({ type: "spki", format: "der" })) };
};
export function signSetupDescriptor(bytes, privateKey) {
  parseSetupDescriptor(bytes);
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      algorithm: "ed25519",
      keyId: identity(privateKey).keyId,
      descriptorSha256: sha256(bytes),
      signature: sign(null, Buffer.concat([context, bytes]), privateKey).toString("base64"),
    }) + "\n",
  );
}
/** Separate signature domain; a release.json signature cannot authorize an executable. */
export function authenticateSetupDescriptor(bytes, signatureBytes, trustedPublicKeys, release) {
  assert(bytes.byteLength <= 16384 && signatureBytes.byteLength <= 4096);
  assert(
    Array.isArray(trustedPublicKeys) &&
      trustedPublicKeys.length > 0 &&
      trustedPublicKeys.length <= 8,
  );
  const metadata = JSON.parse(Buffer.from(signatureBytes).toString("utf8"));
  fields(metadata, ["schemaVersion", "algorithm", "keyId", "descriptorSha256", "signature"]);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.algorithm, "ed25519");
  digest(metadata.keyId);
  assert.equal(metadata.descriptorSha256, sha256(bytes));
  const keys = trustedPublicKeys.map(identity);
  assert.equal(new Set(keys.map((key) => key.keyId)).size, keys.length);
  const signer = keys.find((key) => key.keyId === metadata.keyId);
  assert(signer, "Untrusted Setup signer");
  assert(typeof metadata.signature === "string" && metadata.signature.length === 88);
  const signature = Buffer.from(metadata.signature, "base64");
  assert(signature.length === 64 && signature.toString("base64") === metadata.signature);
  assert(
    verify(null, Buffer.concat([context, Buffer.from(bytes)]), signer.key, signature),
    "Setup signature invalid",
  );
  const descriptor = parseSetupDescriptor(bytes);
  assert.equal(descriptor.version, release.manifest.version, "Setup/application version mismatch");
  assert.equal(
    descriptor.manifestSha256,
    release.manifestSha256,
    "Setup/application manifest mismatch",
  );
  assert.equal(signer.keyId, release.signerKeyId, "Setup/application signer mismatch");
  return { descriptor, descriptorSha256: metadata.descriptorSha256, signerKeyId: signer.keyId };
}
