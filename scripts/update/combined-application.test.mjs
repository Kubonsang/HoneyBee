import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";
import {
  createCombinedApplicationSelection,
  persistCombinedApplicationContext,
  validateCombinedApplicationContext,
  loadCombinedApplicationContext,
} from "./combined-application.mjs";

test("legacy combined contexts require the reproduced source, target runner and observation", () => {
  const context = (change = {}, pointerChange = {}) => {
    const source = {
      schemaVersion: 1,
      generation: 1,
      activeVersion: "0.1.0-beta.35",
      manifestSha256: "272b131a2d3deaffedee07f94e904f9ec1d822d868b8eb2494b60576f947b2cb",
      ...pointerChange,
    };
    const bytes = Buffer.from(JSON.stringify(source));
    const identity = {
      sourcePointerSha256: sha256(bytes),
      manifestSha256: "a".repeat(64),
      serviceTransactionSha256: "b".repeat(64),
    };
    return {
      schemaVersion: 1,
      identity,
      identitySha256: combinedUpdateIdentity(identity),
      launcherSha256: "c".repeat(64),
      sourcePointer: bytes.toString("base64"),
      targetPointer: Buffer.from(
        JSON.stringify({ ...source, generation: 2, activeVersion: "0.1.0-beta.38" }),
      ).toString("base64"),
      nativeCoordinator: "target",
      sourceRecovery: "legacy-hb12-detached",
      sourceObservationSha256: "d".repeat(64),
      ...change,
    };
  };
  assert.equal(validateCombinedApplicationContext(context()).source.activeVersion, "0.1.0-beta.35");
  for (const change of [
    { sourceRecovery: "unknown" },
    { sourceRecovery: undefined },
    { sourceObservationSha256: undefined },
    { nativeCoordinator: undefined },
  ])
    assert.throws(() => validateCombinedApplicationContext(context(change)));
  for (const change of [{ activeVersion: "0.1.0-beta.36" }, { manifestSha256: "e".repeat(64) }]) {
    assert.throws(() => validateCombinedApplicationContext(context({}, change)));
  }
});

test("paired selection preserves source bytes and refuses unknown pointers or lost activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-paired-pointer-"));
  const source = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      activeVersion: "0.1.0-beta.12",
      manifestSha256: "a".repeat(64),
    }) + "\n",
  );
  const target = Buffer.from(
    JSON.stringify({ ...JSON.parse(source), generation: 2, activeVersion: "0.1.0-beta.13" }) + "\n",
  );
  const identity = {
    manifestSha256: "a".repeat(64),
    sourcePointerSha256: sha256(source),
    serviceTransactionSha256: "b".repeat(64),
  };
  const context = {
    schemaVersion: 1,
    identity,
    identitySha256: combinedUpdateIdentity(identity),
    sourcePointer: source.toString("base64"),
    targetPointer: target.toString("base64"),
    launcherSha256: "c".repeat(64),
  };
  await persistCombinedApplicationContext(root, context);
  assert.deepEqual(await loadCombinedApplicationContext(root, context.identitySha256), context);
  const pointer = path.join(root, "current.json"),
    state = path.join(root, "user-state");
  await writeFile(pointer, source);
  await writeFile(state, "dirty project stays here");
  let held = true;
  const selection = createCombinedApplicationSelection(root, context, {
    assertHeld: () => assert(held),
    verifyRelease: async () => true,
  });
  await selection.selectApplication();
  assert.deepEqual(await readFile(pointer), target);
  // Reconstruct from durable context, as a restarted user recovery runner does.
  const recovered = createCombinedApplicationSelection(root, context, {
    assertHeld: () => assert(held),
    verifyRelease: async () => true,
  });
  await recovered.restoreApplication();
  assert.deepEqual(await readFile(pointer), source);
  held = false;
  await assert.rejects(selection.selectApplication());
  assert.deepEqual(await readFile(pointer), source);
  held = true;
  await writeFile(pointer, "unknown");
  await assert.rejects(selection.selectApplication(), /Unknown pointer/u);
  assert.equal(await readFile(state, "utf8"), "dirty project stays here");
});

test("extended recovery records preserve the published strict bootstrapper context shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-legacy-context-"));
  const source = {
    schemaVersion: 1,
    generation: 1,
    activeVersion: "0.1.0-beta.35",
    manifestSha256: "272b131a2d3deaffedee07f94e904f9ec1d822d868b8eb2494b60576f947b2cb",
  };
  const bytes = Buffer.from(JSON.stringify(source));
  const identity = {
    manifestSha256: "a".repeat(64),
    sourcePointerSha256: sha256(bytes),
    serviceTransactionSha256: "b".repeat(64),
  };
  const context = {
    schemaVersion: 1,
    identity,
    identitySha256: combinedUpdateIdentity(identity),
    sourcePointer: bytes.toString("base64"),
    targetPointer: Buffer.from(
      JSON.stringify({ ...source, generation: 2, activeVersion: "0.1.0-beta.38" }),
    ).toString("base64"),
    launcherSha256: "c".repeat(64),
    nativeCoordinator: "target",
    sourceRecovery: "legacy-hb12-detached",
    sourceObservationSha256: "d".repeat(64),
  };
  const destination = await persistCombinedApplicationContext(root, context);
  const original = JSON.parse(await readFile(destination));
  assert.deepEqual(
    Object.keys(original).sort(),
    [
      "schemaVersion",
      "identity",
      "identitySha256",
      "sourcePointer",
      "targetPointer",
      "launcherSha256",
    ].sort(),
  );
  assert.deepEqual(await loadCombinedApplicationContext(root, context.identitySha256), context);
  assert.equal(await persistCombinedApplicationContext(root, context), destination);
  // A repeated call may not remove a durable target/recovery choice.
  await assert.rejects(
    persistCombinedApplicationContext(root, original),
    /selection already exists/u,
  );
  const extensionPath = path.join(
    root,
    "update/combined-recovery",
    context.identitySha256 + ".json",
  );
  const extensionBytes = await readFile(extensionPath);
  const extension = JSON.parse(extensionBytes);
  for (const changed of [
    { ...extension, sourceObservationSha256: undefined },
    { ...extension, sourceRecovery: "unknown" },
    { ...extension, identitySha256: "f".repeat(64) },
    { ...extension, contextSha256: "f".repeat(64) },
    { ...extension, arbitraryCommand: "do-not-execute" },
  ]) {
    await writeFile(extensionPath, JSON.stringify(changed));
    await assert.rejects(loadCombinedApplicationContext(root, context.identitySha256));
  }
  await writeFile(extensionPath, extensionBytes);
  await writeFile(destination, JSON.stringify({ ...original, launcherSha256: "f".repeat(64) }));
  await assert.rejects(
    loadCombinedApplicationContext(root, context.identitySha256),
    /context changed/u,
  );
});
