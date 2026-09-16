import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { compareVersions, sha256 } from "./release-manifest.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";

export function validateCombinedApplicationContext(value) {
  assert.equal(value.schemaVersion, 1);
  assert(
    value.nativeCoordinator === undefined || value.nativeCoordinator === "target",
    "Unsupported native coordinator selection",
  );
  assert.equal(value.identitySha256, combinedUpdateIdentity(value.identity));
  const sourceBytes = Buffer.from(value.sourcePointer, "base64"),
    targetBytes = Buffer.from(value.targetPointer, "base64");
  assert(
    sourceBytes.length > 0 &&
      sourceBytes.length <= 65536 &&
      targetBytes.length > 0 &&
      targetBytes.length <= 65536,
  );
  assert.equal(sourceBytes.toString("base64"), value.sourcePointer);
  assert.equal(targetBytes.toString("base64"), value.targetPointer);
  assert.equal(sha256(sourceBytes), value.identity.sourcePointerSha256);
  const source = JSON.parse(sourceBytes),
    target = JSON.parse(targetBytes);
  for (const pointer of [source, target]) {
    assert.deepEqual(Object.keys(pointer).sort(), [
      "activeVersion",
      "generation",
      "manifestSha256",
      "schemaVersion",
    ]);
    assert(
      pointer.schemaVersion === 1 &&
        Number.isSafeInteger(pointer.generation) &&
        pointer.generation > 0,
    );
    assert(/^[a-f0-9]{64}$/u.test(pointer.manifestSha256));
    compareVersions(pointer.activeVersion, "0.0.0");
  }
  assert(compareVersions(target.activeVersion, source.activeVersion) > 0);
  assert.equal(target.generation, source.generation + 1);
  assert(/^[a-f0-9]{64}$/u.test(value.launcherSha256));
  return { sourceBytes, targetBytes, source, target };
}

export async function persistCombinedApplicationContext(root, value) {
  validateCombinedApplicationContext(value);
  const directory = path.join(path.resolve(root), "update/combined-contexts");
  await mkdir(directory, { recursive: true });
  await plainDirectory(directory);
  const name = path.join(directory, value.identitySha256 + ".json");
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  try {
    assert.deepEqual(await readBounded(name), bytes, "Combined application context changed");
    return name;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, randomUUID() + ".partial");
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await link(temporary, name);
  return name;
}

/** Called under BOTH installation update and exclusive application activity.
 * Only current.json changes. Original pointer bytes live outside versions, so
 * an interrupted switch never needs to reconstruct or rewrite the old release. */
export function createCombinedApplicationSelection(root, value, { assertHeld, verifyRelease }) {
  root = path.resolve(root);
  const { sourceBytes, targetBytes, source, target } = validateCombinedApplicationContext(value);
  assert.equal(typeof assertHeld, "function");
  assert.equal(typeof verifyRelease, "function");
  const change = async (want) => {
    assertHeld();
    const expected = want === "target" ? target : source;
    assert.equal(
      await verifyRelease(path.join(root, "versions", expected.activeVersion)),
      true,
      "Selected release authentication failed",
    );
    const destination = path.join(root, "current.json");
    const current = await readBounded(destination);
    assert(
      current.equals(sourceBytes) || current.equals(targetBytes),
      "Unknown pointer blocks paired activation",
    );
    const bytes = want === "target" ? targetBytes : sourceBytes;
    if (current.equals(bytes)) return;
    const temporary = path.join(root, "update/combined-contexts", `${randomUUID()}.partial`);
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    assertHeld();
    assert.deepEqual(
      await readBounded(destination),
      current,
      "Application selection changed before switch",
    );
    await rename(temporary, destination);
    assert.deepEqual(await readBounded(destination), bytes, "Paired application selection failed");
    assertHeld();
  };
  return { selectApplication: () => change("target"), restoreApplication: () => change("source") };
}
