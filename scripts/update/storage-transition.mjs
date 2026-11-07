import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";

// A compatibility identifier alone is insufficient to reuse an installed
// service. Both authenticated application payloads must bind the same tools.
export function assertMatchingStorageIdentity(source, target) {
  assert.equal(source.schemaVersion, 1);
  assert.equal(target.schemaVersion, 1);
  assert.equal(source.componentVersion, target.componentVersion, "Storage version differs");
  for (const key of ["clientSha256", "controlSha256"]) {
    assert(/^[a-f0-9]{64}$/u.test(source[key]), "Invalid source storage digest");
    assert.equal(
      target[key],
      source[key],
      "Changed storage payload requires a new component version",
    );
  }
}

export async function verifyMatchingStoragePayload(sourceDirectory, targetDirectory) {
  const read = async (directory) =>
    JSON.parse(await readBounded(path.join(directory, "installation.json")));
  assertMatchingStorageIdentity(await read(sourceDirectory), await read(targetDirectory));
}
