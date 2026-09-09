import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { cp, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

import { HoneyBeeWorkspaceCore } from "../../packages/core/dist/index.js";

// This measures Git/Core overhead with a directory-backed test storage adapter.
// It does not qualify physical VHDX allocation or Unity import performance.
const exec = promisify(execFile);
const repository = process.cwd();
const git = async (cwd, ...args) =>
  (
    await exec(
      "git.exe",
      [
        "-c",
        `safe.directory=${cwd.replaceAll("\\", "/")}`,
        "-c",
        "user.name=Benchmark",
        "-c",
        "user.email=benchmark@example.invalid",
        ...args,
      ],
      { cwd, windowsHide: true },
    )
  ).stdout.trim();
const output = path.join(repository, "output", "workspace-base-selection");
await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(path.join(output, "run-"));
const baselineRevision = await git(repository, "rev-parse", "HEAD");
const baselineSource = await git(
  repository,
  "show",
  `${baselineRevision}:packages/core/src/workspace-core.ts`,
);
const baselineRoot = path.join(runRoot, "baseline");
await cp(path.join(repository, "packages", "core", "dist"), baselineRoot, { recursive: true });
await writeFile(
  path.join(baselineRoot, "workspace-core.js"),
  ts.transpileModule(baselineSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText,
);
const { HoneyBeeWorkspaceCore: BaselineCore } = await import(
  pathToFileURL(path.join(baselineRoot, "workspace-core.js")).href
);

class DirectoryStorage {
  calls = { beginParent: 0, commitParent: 0, acquire: 0, retain: 0, attachRetained: 0 };
  leases = new Map();
  async beginParent(_command, parentId) {
    this.calls.beginParent++;
    this.parentId = parentId;
    this.parent = path.join(runRoot, "parent");
    await mkdir(this.parent);
    return { transactionId: parentId, stagingPath: this.parent };
  }
  async commitParent() {
    this.calls.commitParent++;
    return { parentId: this.parentId };
  }
  async acquire(_command, input) {
    this.calls.acquire++;
    const workspacePath = path.join(runRoot, "children", input.workspaceId);
    const mountPath = path.join(workspacePath, "mount");
    await cp(this.parent, mountPath, { recursive: true });
    const lease = { leaseId: input.workspaceId, workspacePath, mountPath };
    this.leases.set(input.consumerId, lease);
    return lease;
  }
  async retain() {
    this.calls.retain++;
  }
  async attachRetained(_command, consumerId) {
    this.calls.attachRetained++;
    return this.leases.get(consumerId);
  }
}

const source = path.join(runRoot, "source");
for (const name of ["Assets", "Packages", "ProjectSettings", "Library"])
  await mkdir(path.join(source, name), { recursive: true });
await writeFile(path.join(source, ".gitignore"), "/Library/\n");
await writeFile(path.join(source, "Assets", "Player.cs"), "class Player {}\n");
await writeFile(path.join(source, "Packages", "manifest.json"), "{}\n");
await writeFile(
  path.join(source, "ProjectSettings", "ProjectVersion.txt"),
  "m_EditorVersion: fixture\n",
);
await writeFile(path.join(source, "Library", "ArtifactDB"), Buffer.alloc(32 * 1024));
await git(source, "init", "-b", "main");
await git(source, "add", ".");
await git(source, "commit", "-m", "fixture");
const tree = await git(source, "rev-parse", "HEAD^{tree}");
let tip = await git(source, "rev-parse", "HEAD");
for (let index = 0; index < 100; index++)
  tip = await git(source, "commit-tree", tree, "-p", tip, "-m", `History ${index}`);
await git(source, "update-ref", "refs/heads/main", tip);
const storage = new DirectoryStorage();
const options = { dataRoot: path.join(runRoot, "registry"), storage };
const current = new HoneyBeeWorkspaceCore(options);
const baseline = new BaselineCore(options);
const project = await current.initProject({
  unityProjectPath: source,
  workspaceRoot: path.join(runRoot, "workspaces"),
  storageCommand: process.execPath,
});
await current.prepareCache(project.projectId);
const snapshot = async (root) => {
  const files = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const info = await stat(file);
    files.push([path.relative(root, file), info.size, info.mtimeMs]);
  }
  return files.sort((a, b) => a[0].localeCompare(b[0]));
};
const beforeQueries = await snapshot(runRoot);
const queryTimes = [];
for (let index = 0; index < 20; index++) {
  const started = performance.now();
  const refs = await current.workspaceBaseRefs(project.projectId);
  await current.workspaceBaseHistory(project.projectId, refs.head.commit);
  queryTimes.push(performance.now() - started);
}
const queryWrites = JSON.stringify(beforeQueries) !== JSON.stringify(await snapshot(runRoot));
const create = async (core, name) => {
  const before = { ...storage.calls };
  const started = performance.now();
  const workspace = await core.createWorkspace({
    project: project.projectId,
    name,
    branch: `bench/${name}`,
    base: tip,
  });
  const elapsedMs = performance.now() - started;
  if (workspace.baseCommit !== tip || workspace.git?.head !== tip || workspace.git?.dirty !== false)
    throw new Error("Incorrect benchmark workspace.");
  return {
    elapsedMs,
    calls: Object.fromEntries(
      Object.entries(storage.calls).map(([key, value]) => [key, value - before[key]]),
    ),
  };
};
await create(baseline, "warm-baseline");
await create(current, "warm-current");
const pairs = [];
for (let index = 0; index < 10; index++) {
  let oldResult, newResult;
  if (index % 2 === 0) {
    oldResult = await create(baseline, `baseline-${index}`);
    newResult = await create(current, `current-${index}`);
  } else {
    newResult = await create(current, `current-${index}`);
    oldResult = await create(baseline, `baseline-${index}`);
  }
  pairs.push({ baseline: oldResult, current: newResult });
  process.stdout.write(`Completed create pair ${index + 1}/10\n`);
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const baselineMedianMs = median(pairs.map((pair) => pair.baseline.elapsedMs));
const currentMedianMs = median(pairs.map((pair) => pair.current.elapsedMs));
const queryP95Ms = [...queryTimes].sort((a, b) => a - b)[Math.ceil(queryTimes.length * 0.95) - 1];
const report = {
  measuredAt: new Date().toISOString(),
  baselineRevision,
  platform: `${os.platform()} ${os.release()}`,
  node: process.version,
  storage: "directory-backed test adapter; physical VHDX and Unity not measured",
  fixture: { commits: 101, trackedFiles: 4, libraryBytes: 32 * 1024 },
  queryTimes,
  queryP95Ms,
  queryWrites,
  baselineMedianMs,
  currentMedianMs,
  createAllowanceMs: Math.max(100, baselineMedianMs * 0.05),
  queryGatePassed: queryP95Ms <= 500 && !queryWrites,
  createGatePassed: currentMedianMs - baselineMedianMs <= Math.max(100, baselineMedianMs * 0.05),
  identicalStorageCalls: pairs.every(
    (pair) => JSON.stringify(pair.baseline.calls) === JSON.stringify(pair.current.calls),
  ),
  pairs,
};
await writeFile(path.join(runRoot, "results.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(
  JSON.stringify({ results: path.join(runRoot, "results.json"), ...report }, null, 2) + "\n",
);
