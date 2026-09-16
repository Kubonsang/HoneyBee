import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { compareVersions, sha256 } from "./release-manifest.mjs";

export async function verifyRecoverySourceFiles(root, approved) {
  const release = path.join(root, "versions", approved.version);
  await plainDirectory(release);
  const seen = [];
  const walk = async (relative = "") => {
    for (const name of await readdir(path.join(release, relative))) {
      const entry = relative ? relative + "/" + name : name;
      const file = path.join(release, entry),
        info = await lstat(file);
      assert(!info.isSymbolicLink(), "Redirected recovery source");
      if (info.isDirectory()) {
        await plainDirectory(file);
        await walk(entry);
      } else {
        assert(
          info.isFile() && Object.hasOwn(approved.files, entry),
          "Unexpected recovery source file",
        );
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(file)) hash.update(bytes);
        assert.equal(hash.digest("hex"), approved.files[entry], "Recovery source payload changed");
        seen.push(entry);
      }
    }
  };
  await walk();
  assert.deepEqual(
    seen.sort(),
    Object.keys(approved.files).sort(),
    "Recovery source inventory incomplete",
  );
  const installation = JSON.parse(await readBounded(path.join(release, "installation.json")));
  assert.equal(installation.activity?.protocol, 1, "Source requires activity participation");
}

/** Canonical signed file inventory, independent of extractor JSON formatting. */
export function recoveryInventoryBytes(files) {
  assert(files && typeof files === "object" && !Array.isArray(files));
  const names = Object.keys(files).sort();
  assert(names.length > 0 && names.length <= 10000);
  const canonical = Object.create(null);
  const seen = new Set();
  for (const name of names) {
    assert(!/[\\:]/u.test(name) && name.split("/").every((p) => p && p !== "." && p !== ".."));
    assert(!seen.has(name.toLowerCase()), "Duplicate recovery path");
    seen.add(name.toLowerCase());
    const entry = files[name];
    assert.deepEqual(Object.keys(entry).sort(), ["sha256", "size"]);
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0);
    assert(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/u.test(entry.sha256));
    canonical[name] = { size: entry.size, sha256: entry.sha256 };
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: canonical }));
  assert(bytes.length <= 8 * 1024 * 1024, "Recovery inventory too large");
  return bytes;
}

function approvedInventory(authenticated, inventoryBytes, pointer) {
  const manifest = authenticated.manifest;
  assert(manifest.recovery, "Release has no signed recovery inventory");
  assert.equal(manifest.version, pointer.activeVersion, "Wrong recovery release");
  assert.equal(
    manifest.recovery.launchManifestSha256,
    pointer.manifestSha256,
    "Wrong recovery launch pin",
  );
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.schemaVersion, 1);
  const canonical = recoveryInventoryBytes(inventory.files);
  assert.equal(sha256(canonical), manifest.recovery.inventorySha256, "Recovery inventory changed");
  assert.equal(inventory.files["launch.json"]?.sha256, pointer.manifestSha256);
  for (const name of [
    "installation.json",
    "runtime/node.exe",
    "desktop/HoneyBee.exe",
    "cli/dist/cli.js",
  ])
    assert(inventory.files[name], "Incomplete recovery payload");
  return {
    schemaVersion: 1,
    version: manifest.version,
    launchSha256: pointer.manifestSha256,
    files: Object.fromEntries(
      Object.entries(inventory.files).map(([name, entry]) => [name, entry.sha256]),
    ),
  };
}

/** Proof is publisher authority for bytes, not proof of health or permission to switch. */
export async function persistRecoverySource({ installationRoot, authenticated, inventoryBytes }) {
  if (!authenticated.manifest.recovery) return;
  const manifest = authenticated.manifest;
  approvedInventory(authenticated, inventoryBytes, {
    activeVersion: manifest.version,
    manifestSha256: manifest.recovery.launchManifestSha256,
  });
  const parent = path.join(path.resolve(installationRoot), "update/recovery-sources");
  await mkdir(parent, { recursive: true });
  await plainDirectory(parent);
  const directory = path.join(parent, manifest.version);
  await mkdir(directory);
  await plainDirectory(directory);
  for (const [name, bytes] of [
    ["release.json", authenticated.manifestBytes],
    ["release.sig.json", authenticated.signatureBytes],
    ["inventory.json", recoveryInventoryBytes(JSON.parse(inventoryBytes).files)],
  ]) {
    const file = await open(path.join(directory, name), "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

export async function resolveRecoverySource({ installationRoot, runtime, pointer }) {
  compareVersions(pointer.activeVersion, "0.0.0");
  const initial = JSON.parse(await readBounded(path.join(runtime, "approved-source.json")));
  assert.equal(initial.schemaVersion, 1);
  if (initial.version === pointer.activeVersion) {
    assert.equal(initial.launchSha256, pointer.manifestSha256, "Initial recovery source changed");
    return initial;
  }
  const trust = JSON.parse(await readBounded(path.join(runtime, "update-trust.json")));
  assert.equal(trust.schemaVersion, 1);
  const directory = path.join(
    path.resolve(installationRoot),
    "update/recovery-sources",
    pointer.activeVersion,
  );
  await plainDirectory(directory);
  const authenticated = authenticateReleaseManifest(
    await readBounded(path.join(directory, "release.json")),
    await readBounded(path.join(directory, "release.sig.json"), 4096),
    trust.publicKeys,
  );
  assert.equal(authenticated.manifest.channel, trust.channel);
  assert(
    compareVersions(trust.bootstrapperVersion, authenticated.manifest.minimumBootstrapperVersion) >=
      0,
    "Recovery bootstrapper too old",
  );
  return approvedInventory(
    authenticated,
    await readBounded(path.join(directory, "inventory.json"), 8 * 1024 * 1024),
    pointer,
  );
}
