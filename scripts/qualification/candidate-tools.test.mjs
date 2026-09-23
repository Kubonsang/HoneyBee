import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindCandidateTools } from "./candidate-tools.mjs";

async function fixture(t, qa = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hb-candidate-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("new host build");
  const manifest = {
    schemaVersion: 1,
    workspaceStorageVersion: "0.0.0+cfa606fd4143.hb13" + (qa ? ".qa-baseline" : ""),
    ...(qa ? { qualificationOnly: true, historicalRelease: false } : {}),
    files: {
      "host.exe": {
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
  await writeFile(path.join(directory, "host.exe"), bytes);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const compatibility = {
    workspaceStorage: [
      { version: "old", payloads: [{ fileName: "host.exe", sha256: "stale", byteLength: 1 }] },
    ],
  };
  return { directory, manifest, compatibility };
}

test("production candidate binds fresh digests without changing source metadata", async (t) => {
  const f = await fixture(t),
    result = await bindCandidateTools(f.directory, f.compatibility, false);
  assert.equal(result.workspaceStorage[0].payloads[0].sha256, f.manifest.files["host.exe"].sha256);
  assert.equal(f.compatibility.workspaceStorage[0].payloads[0].sha256, "stale");
});
test("modified tool bytes are rejected", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "host.exe"), "bad host build");
  await assert.rejects(
    bindCandidateTools(f.directory, f.compatibility, false),
    /Tool digest mismatch/,
  );
});

test("hb15 production candidate binds the heartbeat service payload", async (t) => {
  const f = await fixture(t);
  f.manifest.workspaceStorageVersion = "0.0.0+cfa606fd4143.hb15";
  await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  const result = await bindCandidateTools(f.directory, f.compatibility, false);
  assert.equal(result.workspaceStorage[0].version, f.manifest.workspaceStorageVersion);
  assert.equal(result.workspaceStorage[0].payloads[0].sha256, f.manifest.files["host.exe"].sha256);
});

test("hb15 qualification payload cannot masquerade as a production build", async (t) => {
  const f = await fixture(t, true);
  f.manifest.workspaceStorageVersion = "0.0.0+cfa606fd4143.hb15";
  await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(bindCandidateTools(f.directory, f.compatibility, false));
});

test("hb16 production candidate binds the long-parent-path fix", async (t) => {
  const f = await fixture(t);
  f.manifest.workspaceStorageVersion = "0.0.0+cfa606fd4143.hb16";
  await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  const result = await bindCandidateTools(f.directory, f.compatibility, false);
  assert.equal(result.workspaceStorage[0].version, f.manifest.workspaceStorageVersion);
});

test("an unreviewed future component version is rejected", async (t) => {
  const f = await fixture(t);
  f.manifest.workspaceStorageVersion = "0.0.0+cfa606fd4143.hb17";
  await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(bindCandidateTools(f.directory, f.compatibility, false));
});
test("QA tools cannot enter a production candidate", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(bindCandidateTools(f.directory, f.compatibility, false));
  assert.equal(
    (await bindCandidateTools(f.directory, f.compatibility, true)).workspaceStorage[0].version,
    f.manifest.workspaceStorageVersion,
  );
});

test("optical correction binds only to a QA candidate", async (t) => {
  const f = await fixture(t, true);
  f.manifest.workspaceStorageVersion = "0.0.0+cfa606fd4143.hb13.topology2.qa-baseline";
  await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(bindCandidateTools(f.directory, f.compatibility, false));
  assert.equal(
    (await bindCandidateTools(f.directory, f.compatibility, true)).workspaceStorage[0].version,
    f.manifest.workspaceStorageVersion,
  );
});
