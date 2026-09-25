import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPublicKey, sign, verify } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  assertExternalKeyPath,
  createProtectedReleaseKey,
  loadProtectedReleaseKey,
} from "./release-key.mjs";

test("private keys cannot be generated in repository output or a relative path", () => {
  assert.throws(() => assertExternalKeyPath(path.resolve("output/release.dpapi")));
  assert.throws(() => assertExternalKeyPath("release.dpapi"));
  assert.throws(() => assertExternalKeyPath(path.join(tmpdir(), "release.pem")));
});

test(
  "DPAPI key roundtrip signs, stores no plaintext, and refuses replacement",
  { skip: process.platform !== "win32" ? "windows-native: dpapi" : false },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "honeybee-key-test-"));
    const keyPath = path.join(parent, "private", "release.dpapi");
    const publicKey = await createProtectedReleaseKey(keyPath);
    const encrypted = await readFile(keyPath);
    const key = await loadProtectedReleaseKey(keyPath);
    const raw = key.export({ type: "pkcs8", format: "der" });
    assert.equal(encrypted.includes(raw), false);
    raw.fill(0);
    const message = Buffer.from("isolated fixture signing");
    assert(verify(null, message, createPublicKey(publicKey), sign(null, message, key)));
    await assert.rejects(
      createProtectedReleaseKey(keyPath),
      /Protected release key operation failed/,
    );
    assert.deepEqual(await readFile(keyPath), encrypted);
    assert.equal(
      createPublicKey(await loadProtectedReleaseKey(keyPath)).export({
        type: "spki",
        format: "pem",
      }),
      publicKey,
    );
  },
);
