import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, readdir, lstat, readFile } from "node:fs/promises";
import { plainDirectory } from "../update/stage-release.mjs";

export const cacheSeed = "Synthetic cache seed for real VHDX lifecycle qualification.\n";

// external-bee-dag-v1 requires a regular Bee tree even for a synthetic seed.
// These bytes exercise storage preservation, not a Unity import/build.
export async function seedBee(project) {
  await plainDirectory(project);
  await plainDirectory(path.join(project, "Library"));
  await mkdir(path.join(project, "Library/Bee"));
  await writeFile(path.join(project, "Library/Bee/qa-seed.txt"), cacheSeed, { flag: "wx" });
}

export async function finishDataset({ root, project, projectId, cli }) {
  await cli(["cache", "prepare", "--project", projectId]);
  const created = await cli([
    "workspace",
    "create",
    "preserved",
    "--branch",
    "qa-preserved",
    "--project",
    projectId,
  ]);
  assert.equal(created.workspace.state, "ready");
  assert.equal(created.workspace.available, true);
  assert.equal(
    path.resolve(created.workspace.workspacePath).toLowerCase(),
    path.join(root, "QA 데이터", "Workspaces", "preserved").toLowerCase(),
    "CLI returned a Workspace outside the QA dataset",
  );
  for (const worktree of [project, created.workspace.workspacePath]) {
    await plainDirectory(path.join(worktree, "Assets"));
    assert.equal(
      (await readFile(path.join(worktree, "Assets/Source.txt"), "utf8")).replace(/\r\n/gu, "\n"),
      "committed source\n",
    );
    await writeFile(path.join(worktree, "Assets/새 파일.txt"), "untracked source\n", {
      flag: "wx",
    });
    await writeFile(path.join(worktree, "Assets/Source.txt"), "dirty tracked source\n");
  }
  return {
    projectId,
    project,
    workspace: created.workspace,
    cacheSeed: "synthetic-not-Unity-import-qualification",
  };
}

// Explicit, one-attempt recovery for the reviewed 2026-09-14 fixture failure.
// Never re-register, initialize Git again, abort a pending build, or remove data.
export async function resumeMissingBeeDataset({ root, guest, registry, run, cli, health }) {
  assert.equal(path.resolve(root).toLowerCase(), "c:\\honeybeeqa\\final-integrated-20260914");
  assert.equal(guest.computerName, "DESKTOP-9LT0JVV");
  assert.equal(guest.userSid, "S-1-5-21-4199076252-3622841657-4011401391-1001");
  assert.equal(guest.elevated, false);
  const { project, projectId } = await inspectMissingBeeDataset({ root, guest, registry, run });
  await health(); // pinned baseline version, receipt/hash, SCM and Doctor
  await seedBee(project);
  return finishDataset({ root, project, projectId, cli });
}

export async function inspectMissingBeeDataset({ root, guest, registry, run }) {
  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.projects.length, 1);
  assert.deepEqual(registry.workspaces, []);
  assert.deepEqual(registry.removalReceipts, []);
  const project = path.join(root, "QA 데이터", "Unity 프로젝트");
  const entry = registry.projects[0];
  assert.equal(entry.projectId, "25e6825e-4c06-4095-8721-0b4cc2acd985");
  assert.equal(entry.unityProjectPath, project);
  assert.equal(entry.repositoryRoot, project);
  assert.equal(entry.unityRelativePath, "");
  assert.equal(entry.workspaceRoot, path.join(root, "QA 데이터", "Workspaces"));
  assert.equal(entry.cache, undefined, "A cache already exists; preserve it");
  assert.deepEqual(entry.storageBinding, {
    kind: "managed-v1",
    installationRoot: guest.installationRoot,
  });
  for (const name of [
    root,
    path.dirname(project),
    project,
    path.join(project, ".git"),
    path.join(project, "Library"),
  ])
    await plainDirectory(name);
  await assertLegacySeed(project);
  // The failed commit must already have been aborted. Any surviving native
  // state requires investigation; this recovery never cleans it up itself.
  await plainDirectory(guest.storeRoot);
  const sidRoot = path.join(guest.storeRoot, guest.userSid);
  await plainDirectory(sidRoot);
  assert.deepEqual(
    (await readdir(sidRoot)).sort(),
    ["children", "leases", "parents", "pending", "quarantine", "receipts", "retained"].sort(),
  );
  for (const name of await readdir(sidRoot)) {
    await plainDirectory(path.join(sidRoot, name));
    assert.deepEqual(
      await readdir(path.join(sidRoot, name)),
      [],
      `Retained storage state: ${name}`,
    );
  }
  const workspaceRoot = await lstat(entry.workspaceRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (workspaceRoot) {
    await plainDirectory(entry.workspaceRoot);
    assert.deepEqual(await readdir(entry.workspaceRoot), [], "Existing Workspace data preserved");
  }
  const git = async (args) =>
    (
      await run("git.exe", [
        "-c",
        `safe.directory=${project}`,
        "-c",
        "core.hooksPath=NUL",
        "-C",
        project,
        ...args,
      ])
    ).stdout;
  assert.equal(
    await git(["status", "--porcelain=v1", "--untracked-files=all"]),
    "",
    "Project edits preserved",
  );
  assert.equal((await git(["branch", "--show-current"])).trim(), "main");
  assert.equal((await git(["branch", "--list", "qa-preserved"])).trim(), "");
  assert.equal((await git(["rev-list", "--count", "HEAD"])).trim(), "1");
  assert.equal(
    await git(["ls-files"]),
    ".gitignore\nAssets/Source.txt\nPackages/manifest.json\nProjectSettings/ProjectVersion.txt\n",
  );
  for (const [relative, bytes] of Object.entries({
    ".gitignore": "Library/\nTemp/\n",
    "Assets/Source.txt": "committed source\n",
    "Packages/manifest.json": '{"dependencies":{}}\n',
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
  })) {
    await plainDirectory(path.dirname(path.join(project, relative)));
    const info = await lstat(path.join(project, relative));
    assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(await readFile(path.join(project, relative), "utf8"), bytes);
  }
  return { project, projectId: entry.projectId };
}

export async function assertLegacySeed(project) {
  const library = path.join(project, "Library");
  await plainDirectory(library);
  assert.deepEqual(
    await readdir(library),
    ["qa-cache.txt"],
    "Only the reviewed missing-Bee fixture can resume",
  );
  const file = path.join(library, "qa-cache.txt");
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink());
  assert.equal(await readFile(file, "utf8"), cacheSeed);
}
