import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, lstat, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readEmptyQARegistry } from "./qa-registry.mjs";
import { sha256 } from "../update/release-manifest.mjs";
const fixture = async () => {
  const base = path.resolve("output/qa-registry-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, "case-"));
};
test("missing registry directory stays absent", async () => {
  const root = await fixture(),
    file = path.join(root, "workspace-core/workspace-registry-v2.json");
  assert.deepEqual(await readEmptyQARegistry(file), { digest: null });
  await assert.rejects(lstat(path.dirname(file)), { code: "ENOENT" });
});
test("missing file and existing empty registry have distinct snapshots", async () => {
  const root = await fixture(),
    file = path.join(root, "registry.json");
  assert.deepEqual(await readEmptyQARegistry(file), { digest: null });
  const bytes = JSON.stringify({
    schemaVersion: 2,
    projects: [],
    workspaces: [],
    removalReceipts: [],
  });
  await writeFile(file, bytes);
  assert.deepEqual(await readEmptyQARegistry(file), { digest: sha256(bytes) });
});
for (const value of [
  "invalid JSON",
  JSON.stringify({}),
  JSON.stringify({ schemaVersion: 2, projects: [{}], workspaces: [] }),
  JSON.stringify({ schemaVersion: 2, projects: [], workspaces: [{}] }),
])
  test(`refuses invalid or occupied registry: ${value}`, async () => {
    const file = path.join(await fixture(), "registry.json");
    await writeFile(file, value);
    await assert.rejects(readEmptyQARegistry(file));
  });
test("redirected missing registry is not treated as an empty installation", async () => {
  const root = await fixture(),
    real = path.join(root, "real"),
    alias = path.join(root, "alias");
  await mkdir(real);
  await symlink(real, alias, "junction");
  await assert.rejects(readEmptyQARegistry(path.join(alias, "missing/registry.json")));
});
