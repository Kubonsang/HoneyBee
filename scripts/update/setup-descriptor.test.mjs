import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import {
  authenticateSetupDescriptor,
  parseSetupDescriptor,
  signSetupDescriptor,
  setupAssetUrl,
} from "./setup-descriptor.mjs";

const keys = generateKeyPairSync("ed25519");
const version = "0.1.0-beta.40";
const keyId = sha256(keys.publicKey.export({ type: "spki", format: "der" }));
const release = { manifest: { version }, manifestSha256: "a".repeat(64), signerKeyId: keyId };
const descriptor = () => ({
  schemaVersion: 1,
  version,
  manifestSha256: release.manifestSha256,
  setup: { url: setupAssetUrl(version, "HoneyBeeSetup.exe"), size: 10, sha256: "b".repeat(64) },
});
const bytes = Buffer.from(JSON.stringify(descriptor()));
const signature = signSetupDescriptor(bytes, keys.privateKey);
test("Setup authentication binds exact bytes to the signed application release", () => {
  assert.equal(
    authenticateSetupDescriptor(bytes, signature, [keys.publicKey], release).descriptor.version,
    version,
  );
  for (const altered of [
    { ...release, manifestSha256: "c".repeat(64) },
    { ...release, manifest: { version: "0.1.0-beta.41" } },
    { ...release, signerKeyId: "d".repeat(64) },
  ])
    assert.throws(() => authenticateSetupDescriptor(bytes, signature, [keys.publicKey], altered));
});
test("unknown keys, modified bytes and noncanonical signatures are refused", () => {
  assert.throws(() =>
    authenticateSetupDescriptor(
      bytes,
      signature,
      [generateKeyPairSync("ed25519").publicKey],
      release,
    ),
  );
  assert.throws(() =>
    authenticateSetupDescriptor(
      Buffer.concat([bytes, Buffer.from(" ")]),
      signature,
      [keys.publicKey],
      release,
    ),
  );
  const metadata = JSON.parse(signature);
  metadata.signature = metadata.signature.slice(1);
  assert.throws(() =>
    authenticateSetupDescriptor(
      bytes,
      Buffer.from(JSON.stringify(metadata)),
      [keys.publicKey],
      release,
    ),
  );
});
test("release-manifest signature context cannot authorize Setup", () => {
  const metadata = JSON.parse(signature);
  metadata.signature = sign(
    null,
    Buffer.concat([Buffer.from("HoneyBee release manifest signature v1\n"), bytes]),
    keys.privateKey,
  ).toString("base64");
  assert.throws(() =>
    authenticateSetupDescriptor(
      bytes,
      Buffer.from(JSON.stringify(metadata)),
      [keys.publicKey],
      release,
    ),
  );
});
test("Setup descriptor rejects arbitrary hosts, tags, commands and unbounded sizes", () => {
  for (const url of [
    "https://example.com/HoneyBeeSetup.exe",
    setupAssetUrl("0.1.0-beta.39", "HoneyBeeSetup.exe"),
    setupAssetUrl(version, "release.json"),
    setupAssetUrl(version, "HoneyBeeSetup.exe") + "?x=1",
  ]) {
    const value = descriptor();
    value.setup.url = url;
    assert.throws(() => parseSetupDescriptor(Buffer.from(JSON.stringify(value))));
  }
  for (const size of [0, -1, 2 ** 40, 1.5]) {
    const value = descriptor();
    value.setup.size = size;
    assert.throws(() => parseSetupDescriptor(Buffer.from(JSON.stringify(value))));
  }
  assert.throws(() =>
    parseSetupDescriptor(Buffer.from(JSON.stringify({ ...descriptor(), command: "bad" }))),
  );
});
