import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  snapshotGitWorktree,
  assertPreserved,
  snapshotRegisteredProject,
} from "./preservation.mjs";

test("real Git evidence detects lost edits and branch movement while allowing ignored Library regeneration", async () => {
  const parent = path.resolve("output/preservation-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "프로젝트 case-"));
  const git = async (...args) =>
    promisify(execFile)(
      "git",
      [
        "-c",
        `safe.directory=${root}`,
        "-c",
        "user.name=HoneyBee QA",
        "-c",
        "user.email=qa@example.invalid",
        "-c",
        "core.hooksPath=NUL",
        "-C",
        root,
        ...args,
      ],
      { windowsHide: true },
    );
  await git("init");
  await writeFile(path.join(root, ".gitignore"), "Library/\n");
  await writeFile(path.join(root, "tracked.txt"), "committed\n");
  await git("add", ".");
  await git("commit", "-m", "QA baseline");
  await writeFile(path.join(root, "tracked.txt"), "user edit\n");
  await writeFile(path.join(root, "새 파일.txt"), "untracked user edit\n");
  const before = await snapshotGitWorktree(root);
  await mkdir(path.join(root, "Library"));
  await writeFile(path.join(root, "Library/cache"), "regenerated");
  assert.equal(assertPreserved(before, await snapshotGitWorktree(root)).preserved, true);
  await writeFile(path.join(root, "tracked.txt"), "committed\n");
  assert.throws(() => assertPreserved(before, {}));
  const after = await snapshotGitWorktree(root);
  assert.throws(() => assertPreserved(before, after), /edited file changed/);
  await writeFile(path.join(root, "tracked.txt"), "user edit\n");
  await git("branch", "unexpected-branch");
  const moved = await snapshotGitWorktree(root);
  assert.throws(() => assertPreserved(before, moved), /edited file changed/);
  assert.notEqual(moved.heads, before.heads);
  assert.equal(await readFile(path.join(root, "새 파일.txt"), "utf8"), "untracked user edit\n");
});

test("an empty registry cannot qualify populated Workspace preservation", async () => {
  const parent = path.resolve("output/preservation-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "empty-"));
  await mkdir(path.join(root, "workspace-core"));
  await writeFile(
    path.join(root, "workspace-core/workspace-registry-v2.json"),
    JSON.stringify({ schemaVersion: 2, projects: [], workspaces: [] }),
  );
  await assert.rejects(
    snapshotRegisteredProject({ installationRoot: root, projectId: "qa" }),
    /registered QA project/,
  );
});
