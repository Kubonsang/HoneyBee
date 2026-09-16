import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../..");

export function assertExternalKeyPath(keyPath) {
  assert(
    path.isAbsolute(keyPath) && path.extname(keyPath) === ".dpapi",
    "Absolute .dpapi key path required",
  );
  const relative = path.relative(repository, keyPath);
  assert(
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "Release private keys must stay outside the repository",
  );
}

const crypt = (action, keyPath, input = Buffer.alloc(0)) =>
  new Promise((resolve, reject) => {
    assert.equal(process.platform, "win32", "Windows DPAPI required");
    assertExternalKeyPath(keyPath);
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(here, "protected-release-key.ps1"),
        "-Action",
        action,
        "-KeyPath",
        path.resolve(keyPath),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    let length = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 30000);
    child.on("error", () => {
      failed = true;
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.stderr.resume(); // Never attach potentially sensitive child output to an exception.
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 32768) {
        failed = true;
        child.kill();
        chunk.fill(0);
      } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      if (failed || code !== 0) {
        output.fill(0);
        reject(
          new Error(
            "Protected release key operation failed; check path, ownership and Windows user. Existing keys are never overwritten.",
          ),
        );
      } else resolve(output);
    });
    child.stdin.end(input);
  });

export async function loadProtectedReleaseKey(keyPath) {
  const encoded = await crypt("Unprotect", keyPath);
  const bytes = Buffer.from(encoded.toString("ascii"), "base64");
  try {
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    assert.equal(key.asymmetricKeyType, "ed25519");
    return key;
  } finally {
    encoded.fill(0);
    bytes.fill(0);
  }
}

export async function createProtectedReleaseKey(keyPath) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = privateKey.export({ type: "pkcs8", format: "der" });
  const encoded = Buffer.from(bytes.toString("base64"), "ascii");
  try {
    const result = await crypt("Protect", keyPath, encoded);
    assert.equal(result.toString(), "protected");
  } finally {
    bytes.fill(0);
    encoded.fill(0);
  }
  const restored = await loadProtectedReleaseKey(keyPath);
  const expected = publicKey.export({ type: "spki", format: "pem" });
  assert.equal(createPublicKey(restored).export({ type: "spki", format: "pem" }), expected);
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [action, keyPath, publicPath] = process.argv.slice(2);
  assert(
    ["create", "export-public"].includes(action) && keyPath && publicPath,
    "Usage: release-key.mjs <create|export-public> <external-key.dpapi> <new-public.pem>",
  );
  const publicKey =
    action === "create"
      ? await createProtectedReleaseKey(keyPath)
      : createPublicKey(await loadProtectedReleaseKey(keyPath)).export({
          type: "spki",
          format: "pem",
        });
  const file = await open(publicPath, "wx");
  try {
    await file.writeFile(publicKey);
    await file.sync();
  } finally {
    await file.close();
  }
  process.stdout.write(
    JSON.stringify({ publicKeyPath: path.resolve(publicPath), protected: true }) + "\n",
  );
}
