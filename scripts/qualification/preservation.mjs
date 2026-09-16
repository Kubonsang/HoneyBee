import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { plainDirectory } from "../update/stage-release.mjs";
import { readBounded } from "../update/prepare-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";

/** Read-only source evidence. Ignored Library contents may regenerate; tracked
 * files, untracked nonignored edits, index/status, HEAD and every local branch
 * must remain identical. No checkout, reset, clean, repair or Git hooks run. */
export async function snapshotGitWorktree(directory) {
  const root = path.resolve(directory);
  await plainDirectory(root);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const git = async (args) =>
    (
      await promisify(execFile)(
        "git",
        [
          "-c",
          `safe.directory=${root}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.quotePath=false",
          "--no-optional-locks",
          "-C",
          root,
          ...args,
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, env },
      )
    ).stdout;
  assert.equal(
    path.resolve((await git(["rev-parse", "--show-toplevel"])).trim()).toLowerCase(),
    root.toLowerCase(),
    "Expected a worktree root",
  );
  const control = async () => ({
    head: (await git(["rev-parse", "HEAD"])).trim(),
    branch: (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
    heads: await git([
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]),
    index: await git(["ls-files", "--stage", "-z"]),
    status: await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  });
  const before = await control();
  const names = [
    ...new Set(
      (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  assert(names.length > 0 && names.length <= 10000, "Fixed QA dataset size exceeded");
  const files = {};
  for (const name of names) {
    assert(
      !/[\\:]/u.test(name) && name.split("/").every((p) => p && p !== "." && p !== ".."),
      "Unsafe tracked path",
    );
    const file = path.join(root, name);
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      files[name] = { missing: true };
      continue;
    }
    await plainDirectory(path.dirname(file));
    assert(info.isFile() && !info.isSymbolicLink(), "QA source must contain ordinary files");
    const hash = createHash("sha256");
    let size = 0;
    for await (const bytes of createReadStream(file)) {
      hash.update(bytes);
      size += bytes.length;
    }
    assert.equal(size, info.size, "QA source changed while hashing");
    files[name] = { size, sha256: hash.digest("hex") };
  }
  assert.deepEqual(await control(), before, "Git changed during preservation snapshot");
  return { schemaVersion: 1, root, ...before, files };
}

/** The final dataset must already have a real registered, ready Workspace.
 * This records bindings and source files; Doctor separately validates live storage. */
export async function snapshotRegisteredProject({ installationRoot, projectId }) {
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  const registryPath = path.join(root, "workspace-core/workspace-registry-v2.json");
  const bytes = await readBounded(registryPath, 8 * 1024 * 1024),
    registry = JSON.parse(bytes);
  assert.equal(registry.schemaVersion, 2);
  assert(Array.isArray(registry.projects) && Array.isArray(registry.workspaces));
  const projects = registry.projects.filter((p) => p.projectId === projectId);
  assert.equal(projects.length, 1, "Exactly one registered QA project required");
  const project = projects[0],
    workspaces = registry.workspaces.filter((w) => w.projectId === projectId);
  assert(workspaces.length > 0 && workspaces.length <= 8, "Populated QA Workspace required");
  assert(
    workspaces.every(
      (w) =>
        w.state === "ready" &&
        w.layout === "git-worktree-library-cow-v1" &&
        [w.storageWorkspaceId, w.parentId, w.leaseId, w.consumerId].every(
          (v) => typeof v === "string" && v.length > 0,
        ),
    ),
    "Real ready storage bindings required",
  );
  const repositories = [];
  for (const directory of [
    ...new Set([project.repositoryRoot, ...workspaces.map((w) => w.workspacePath)]),
  ].sort())
    repositories.push(await snapshotGitWorktree(directory));
  assert.deepEqual(
    await readBounded(registryPath, 8 * 1024 * 1024),
    bytes,
    "Registry changed during snapshot",
  );
  return {
    schemaVersion: 1,
    projectId,
    registrySha256: sha256(bytes),
    project,
    workspaces,
    repositories,
  };
}

export function assertPreserved(before, after) {
  assert.equal(before.schemaVersion, 1);
  assert.equal(after.schemaVersion, 1);
  assert.deepEqual(
    after,
    before,
    "Project, Workspace binding, branch, index or edited file changed",
  );
  return { schemaVersion: 1, preserved: true };
}
