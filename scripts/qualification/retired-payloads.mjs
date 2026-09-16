import assert from "node:assert/strict";
import path from "node:path";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";

const allowed = new Set([
  "HoneyBeeSetup.exe",
  "HoneyBeeSetup-qualification-baseline.exe",
  "updates/service/application.zip",
  "updates/app-1/application.zip",
  "updates/app-2/application.zip",
  "updates/topology-bridge/application.zip",
  "updates/topology-compression/application.zip",
]);
// Only obsolete QA transport copies with verified host preservation. Never
// installation versions, store backups, VHDX, workspace files or result records.
export function validateRetiredPayloads(entries) {
  assert(Array.isArray(entries) && entries.length <= allowed.size);
  const seen = new Set();
  for (const entry of entries) {
    assert(entry && typeof entry === "object");
    assert(allowed.has(entry.path) && !seen.has(entry.path));
    seen.add(entry.path);
    assert(entry.hostCopyVerified === true && /^[a-f0-9]{64}$/u.test(entry.sha256));
    assert(Number.isSafeInteger(entry.size) && entry.size > 0);
  }
}

export async function retireReviewedPayloads(bundle, entries) {
  validateRetiredPayloads(entries);
  const root = "C:\\HoneyBeeQA\\final-integrated-20260914";
  await plainDirectory(root);
  const present = [];
  for (const entry of entries) {
    const file = path.join(root, entry.path);
    await plainDirectory(path.dirname(file));
    const info = await lstat(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) continue;
    assert(info.isFile() && !info.isSymbolicLink());
    assert.deepEqual(await digestDistributionFile(file), {
      sha256: entry.sha256,
      size: entry.size,
    });
    present.push({ ...entry, file });
  }
  const evidence = path.join(bundle, "Cleanup");
  await mkdir(evidence, { recursive: true });
  await plainDirectory(evidence);
  const id = randomUUID();
  await durableQARecord(path.join(evidence, id + "-intent.json"), { schemaVersion: 1, present });
  for (const entry of present) await unlink(entry.file);
  await durableQARecord(path.join(evidence, id + "-completed.json"), {
    schemaVersion: 1,
    removed: present.length,
    bytes: present.reduce((n, e) => n + e.size, 0),
  });
}
