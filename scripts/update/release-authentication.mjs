import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPublicKey, sign, verify } from "node:crypto";
import { parseReleaseManifest, sha256 } from "./release-manifest.mjs";

const context = Buffer.from("HoneyBee release manifest signature v1\n", "utf8");
const message = (bytes) => Buffer.concat([context, bytes]);
const publicIdentity = (input) => {
  const key = input?.type === "public" ? input : createPublicKey(input);
  assert.equal(key.asymmetricKeyType, "ed25519", "Ed25519 release key required");
  return { key, keyId: sha256(key.export({ type: "spki", format: "der" })) };
};

/** Release tooling only. Never generates keys or persists private key material. */
export const signReleaseManifest = (manifestBytes, privateKey) => {
  const bytes = Buffer.from(manifestBytes);
  const manifestSha256 = sha256(bytes);
  parseReleaseManifest(bytes, manifestSha256);
  const { keyId } = publicIdentity(privateKey);
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      algorithm: "ed25519",
      keyId,
      manifestSha256,
      signature: sign(null, message(bytes), privateKey).toString("base64"),
    }) + "\n",
  );
};

/** trustedPublicKeys must come from the trusted application build, never the feed. */
export const authenticateReleaseManifest = (manifestBytes, signatureBytes, trustedPublicKeys) => {
  const bytes = Buffer.from(manifestBytes);
  assert(bytes.length <= 64 * 1024, "Manifest exceeds 64 KiB");
  assert(signatureBytes.byteLength <= 4096, "Signature metadata exceeds 4 KiB");
  assert(
    Array.isArray(trustedPublicKeys) &&
      trustedPublicKeys.length > 0 &&
      trustedPublicKeys.length <= 8,
    "Release trust keys required",
  );
  const metadata = JSON.parse(Buffer.from(signatureBytes).toString("utf8"));
  assert(metadata && typeof metadata === "object" && !Array.isArray(metadata));
  assert.deepEqual(
    Object.keys(metadata).sort(),
    ["schemaVersion", "algorithm", "keyId", "manifestSha256", "signature"].sort(),
    "Invalid signature metadata fields",
  );
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.algorithm, "ed25519");
  assert(typeof metadata.keyId === "string" && /^[a-f0-9]{64}$/u.test(metadata.keyId));
  assert.equal(metadata.manifestSha256, sha256(bytes), "Signed manifest digest mismatch");
  const trusted = trustedPublicKeys.map(publicIdentity);
  assert.equal(
    new Set(trusted.map((item) => item.keyId)).size,
    trusted.length,
    "Duplicate release trust key",
  );
  const signer = trusted.find((item) => item.keyId === metadata.keyId);
  assert(signer, "Untrusted release signer");
  assert(
    typeof metadata.signature === "string" && metadata.signature.length === 88,
    "Invalid release signature encoding",
  );
  const signature = Buffer.from(metadata.signature, "base64");
  assert(
    signature.length === 64 && signature.toString("base64") === metadata.signature,
    "Invalid release signature encoding",
  );
  assert(
    verify(null, message(bytes), signer.key, signature),
    "Release signature verification failed",
  );
  return {
    manifestBytes: bytes,
    signatureBytes: Buffer.from(signatureBytes),
    manifestSha256: metadata.manifestSha256,
    signerKeyId: signer.keyId,
    manifest: parseReleaseManifest(bytes, metadata.manifestSha256),
  };
};
