import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, cp, readdir } from "node:fs/promises";

const base = path.dirname(fileURLToPath(import.meta.url));
const evidence = path.join(base, "Evidence-adoption");
const root = path.join(process.env.LOCALAPPDATA, "HoneyBee");
const setup = path.join(base, "HoneyBeeSetup.exe");
const expected = "8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const record = (name, value) =>
  writeFile(path.join(evidence, `${name}.json`), JSON.stringify(value, null, 2), { flag: "wx" });
const run = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 8 * 1024 * 1024,
  });
const cli = (args) => JSON.parse(run(path.join(root, "bin/honeybee.exe"), [...args, "--json"]));
const registryPath = path.join(root, "workspace-core/workspace-registry-v2.json");
const receiptPath = "C:\\ProgramData\\UnityWorkspaceStorage\\install-receipt.json";
const git = (directory, args) =>
  run("git.exe", [
    "-c",
    "core.hooksPath=NUL",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "user.name=HoneyBee QA",
    "-c",
    "user.email=qa@example.invalid",
    "--no-optional-locks",
    "-C",
    directory,
    ...args,
  ]);
async function snapshot(directory) {
  const control = () => ({
    head: git(directory, ["rev-parse", "HEAD"]),
    branch: git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
    branches: git(directory, [
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]),
    index: git(directory, ["ls-files", "--stage", "-z"]),
    status: git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  });
  const before = control();
  const files = {};
  for (const name of [
    ...new Set(
      git(directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort()) {
    assert(
      !/[\\:]/u.test(name) &&
        name.split("/").every((part) => part && part !== ".." && part !== "."),
    );
    files[name] = hash(await readFile(path.join(directory, name)));
  }
  assert.deepEqual(control(), before);
  return { ...before, files };
}

await mkdir(evidence); // Existing attempts must never be replayed or overwritten.
let stage = "preflight";
try {
  assert.equal(hash(await readFile(setup)), expected);
  const pointerBytes = await readFile(path.join(root, "current.json"));
  assert.equal(JSON.parse(pointerBytes).activeVersion, "0.1.0-beta.32");
  const listed = cli(["project", "list"]);
  assert.equal(
    listed.projects.length,
    0,
    "Only the empty temporary acceptance installation is admitted",
  );
  assert.equal(cli(["doctor"]).ready, true);
  const receipt = await readFile(receiptPath);
  await record("admission", {
    setupSha256: expected,
    pointerSha256: hash(pointerBytes),
    receiptSha256: hash(receipt),
    portableFixture:
      "compatible beta.32 tools copied outside installation; not historical hb12 migration",
  });
  stage = "dataset";
  const fixture = path.join(base, "ZIP adoption data");
  await mkdir(fixture);
  const portable = path.join(fixture, "Portable ZIP tools");
  await cp(path.join(root, "versions/0.1.0-beta.32/tools"), portable, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const project = path.join(fixture, "Unity project");
  await mkdir(project);
  for (const name of ["Assets", "Packages", "ProjectSettings", "Library/Bee"])
    await mkdir(path.join(project, name), { recursive: true });
  for (const [name, value] of Object.entries({
    ".gitignore": "Library/\nTemp/\n",
    "Assets/Source.txt": "committed source\n",
    "Packages/manifest.json": '{"dependencies":{}}\n',
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
    "Library/Bee/qa-seed.txt": "Synthetic cache seed; not Unity import qualification.\n",
  }))
    await writeFile(path.join(project, name), value, { flag: "wx" });
  git(project, ["init", "--initial-branch=main"]);
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "Disposable ZIP adoption fixture"]);
  const registered = cli([
    "project",
    "init",
    project,
    "--workspace-root",
    path.join(fixture, "Workspaces"),
    "--storage-command",
    path.join(portable, "unity-workspace-storage.exe"),
  ]);
  const projectId = registered.project.projectId;
  assert.equal(registered.project.storageBinding, undefined, "Legacy tool binding required");
  cli(["cache", "prepare", "--project", projectId]);
  const created = cli([
    "workspace",
    "create",
    "zip-preserved",
    "--branch",
    "qa-zip-preserved",
    "--project",
    projectId,
  ]);
  assert.equal(created.workspace.state, "ready");
  const workspace = created.workspace.workspacePath;
  assert.equal(
    path.resolve(workspace).toLowerCase(),
    path.join(fixture, "Workspaces/zip-preserved").toLowerCase(),
  );
  for (const directory of [project, workspace]) {
    await writeFile(path.join(directory, "Assets/Source.txt"), "dirty tracked source\n");
    await writeFile(path.join(directory, "Assets/새 파일.txt"), "untracked source\n", {
      flag: "wx",
    });
  }
  assert.equal(cli(["doctor"]).ready, true);
  const beforeBytes = await readFile(registryPath);
  const before = {
    registry: JSON.parse(beforeBytes),
    project: await snapshot(project),
    workspace: await snapshot(workspace),
  };
  assert.equal(
    before.registry.projects.find((entry) => entry.projectId === projectId).storageBinding,
    undefined,
  );
  await record("before", before);
  const registryDirectory = path.dirname(registryPath);
  const backups = new Set(await readdir(registryDirectory));
  stage = "setup-adoption";
  process.stdout.write("Running matching Setup /ADOPT. Complete and close the installer window.\n");
  run(setup, ["/ADOPT"]);
  stage = "preservation";
  const after = await json(registryPath);
  const adopted = after.projects.find((entry) => entry.projectId === projectId);
  assert(adopted);
  assert.deepEqual(adopted.storageBinding, { kind: "managed-v1", installationRoot: root });
  const expectedRegistry = globalThis.structuredClone(before.registry);
  expectedRegistry.projects.find((entry) => entry.projectId === projectId).storageBinding =
    adopted.storageBinding;
  assert.deepEqual(after, expectedRegistry, "Only the managed storage binding may change");
  assert.deepEqual(
    await snapshot(project),
    before.project,
    "Project edits, index or branches changed",
  );
  assert.deepEqual(
    await snapshot(workspace),
    before.workspace,
    "Workspace edits, index or branches changed",
  );
  const addedBackups = (await readdir(registryDirectory)).filter(
    (name) => name.startsWith("workspace-registry-before-adoption-") && !backups.has(name),
  );
  assert.equal(addedBackups.length, 1, "One original registry backup required");
  assert.deepEqual(await readFile(path.join(registryDirectory, addedBackups[0])), beforeBytes);
  assert.deepEqual(await readFile(path.join(root, "current.json")), pointerBytes);
  assert.deepEqual(await readFile(receiptPath), receipt);
  const doctor = cli(["doctor"]);
  assert.equal(doctor.ready, true);
  const result = {
    schemaVersion: 1,
    zipStyleAdoptionPassed: true,
    preserved: true,
    registryBackupVerified: true,
    serviceReceiptUnchanged: true,
    doctorReady: true,
    projectId,
    setupSha256: expected,
    evidence,
    acceptancePromoted: false,
    publicationAllowed: false,
  };
  await record("completed", result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const result = {
    schemaVersion: 1,
    ok: false,
    stage,
    error: error.message,
    evidence,
    automaticReplay: false,
  };
  await record("failed", result);
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}
