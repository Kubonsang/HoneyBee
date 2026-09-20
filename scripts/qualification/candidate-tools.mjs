import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

// Bind the isolated candidate to its actual tool input, including ordinary
// production builds. Never retain compatibility hashes from a previous build.
export async function bindCandidateTools(directory, compatibility, maintenanceBaseline) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert(
    (maintenanceBaseline
      ? [
          "0.0.0+cfa606fd4143.hb13.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology1.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology2.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology3.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology4.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology5.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology6.qa-baseline",
          "0.0.0+cfa606fd4143.hb13.topology7.qa-baseline",
        ]
      : ["0.0.0+cfa606fd4143.hb13", "0.0.0+cfa606fd4143.hb15"]
    ).includes(manifest.workspaceStorageVersion),
    "Unexpected candidate component version",
  );
  if (maintenanceBaseline) {
    assert.equal(manifest.qualificationOnly, true);
    assert.equal(manifest.historicalRelease, false);
  } else assert.notEqual(manifest.qualificationOnly, true);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert(/^[A-Za-z0-9._-]+\.exe$/u.test(name), "Invalid tool filename");
    const file = path.join(directory, name),
      info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink(), "Ordinary tool file required");
    const bytes = await readFile(file);
    assert.equal(bytes.length, expected.byteLength, "Tool size mismatch: " + name);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      "Tool digest mismatch: " + name,
    );
  }
  assert.equal(compatibility.workspaceStorage.length, 1);
  const bound = globalThis.structuredClone(compatibility),
    item = bound.workspaceStorage[0];
  item.version = manifest.workspaceStorageVersion;
  for (const payload of item.payloads) {
    assert(manifest.files[payload.fileName], "Missing required tool payload");
    payload.sha256 = manifest.files[payload.fileName].sha256;
    payload.byteLength = manifest.files[payload.fileName].byteLength;
  }
  return bound;
}
