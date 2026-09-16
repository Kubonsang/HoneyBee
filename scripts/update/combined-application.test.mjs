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
} from "./combined-application.mjs";

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
