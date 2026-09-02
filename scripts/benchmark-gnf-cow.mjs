import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { promisify } from "node:util";

import { HoneyBeeWorkspaceCore, WindowsWorkspaceStorage } from "../packages/core/dist/index.js";
import {
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
} from "../apps/cli/dist/unity-adapters.js";

const execFileAsync = promisify(execFile);
const projectPath = path.resolve(process.argv[2] ?? "C:/Users/user/DEV/Task_Allocator/GNF_");
const storageCommand = path.resolve(
  process.argv[3] ?? "apps/desktop/.tools/win32-x64/unity-workspace-storage.exe",
);
const outputPath = path.resolve(
  process.argv[4] ?? "docs/benchmarks/gnf-cow-2026-09-01/raw/results.json",
);
const measuredRuns = Number.parseInt(process.argv[5] ?? "6", 10);
const libraryParentOverride = process.argv[6];
const fullParentOverride = process.argv[7];
const workspaceRoot = path.resolve(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "HoneyBee",
  "Workspaces",
);
const runToken = new Date()
  .toISOString()
  .replace(/[-:.TZ]/gu, "")
  .slice(0, 14);
const benchmarkRoot = path.join("C:/tmp", `HoneyBee-GNF-CoW-${runToken}`);
const seedWorktree = path.join(benchmarkRoot, "seed-head");
const fullLogicalRoot = path.join(benchmarkRoot, "full-logical");
const coreDataRoot = path.join(benchmarkRoot, "core-data");
const storage = new WindowsWorkspaceStorage();
const bootstrap = new UnityProjectBootstrap();
let core;

const timed = async (operation) => {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
};

const run = async (commandName, args, cwd = projectPath) => {
  const { stdout, stderr } = await execFileAsync(commandName, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
};

const git = async (args, cwd = projectPath) => {
  const safeDirectory = (await realpath(cwd).catch(() => path.resolve(cwd))).replaceAll("\\", "/");
  return (await run("git.exe", ["-c", `safe.directory=${safeDirectory}`, ...args], cwd)).stdout;
};

const exists = async (candidate) => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const sha256File = async (candidate) =>
  createHash("sha256")
    .update(await readFile(candidate))
    .digest("hex");

const storageStatus = async (requestId) => {
  const { stdout } = await run(storageCommand, ["workspace", "status", "--request-id", requestId]);
  return JSON.parse(stdout).status;
};

const treeMeasure = async (root) => {
  const stack = [root];
  let files = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile()) {
        const info = await stat(candidate);
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { files, bytes };
};

const percentile = (values, ratio) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const upper = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[upper - 1] + sorted[upper]) / 2 : sorted[upper];
};

const summarize = (records, mode) => {
  const selected = records.filter((record) => record.mode === mode && !record.warmup);
  const totals = selected.map((record) => record.readyMs);
  return {
    count: selected.length,
    medianReadyMs: median(totals),
    minReadyMs: Math.min(...totals),
    maxReadyMs: Math.max(...totals),
    p95ReadyMs: percentile(totals, 0.95),
    medianStorageAllocatedBytes: median(selected.map((record) => record.storageAllocatedBytes)),
  };
};

const prepareLibraryParent = async (libraryPath, existingParentId) => {
  if (existingParentId !== undefined) {
    const existing = await storage.beginParent(storageCommand, existingParentId);
    if (existing.transactionId !== undefined) {
      await storage.abortParent(storageCommand, existing.transactionId);
      throw new Error(`Requested Library parent ${existingParentId} does not exist.`);
    }
    return {
      parentId: existing.parentId ?? existingParentId,
      allocatedBytes: existing.allocatedBytes ?? null,
      reused: true,
      beginMs: 0,
      seedCopyMs: 0,
      commitMs: 0,
      totalMs: 0,
    };
  }
  const parentId = createHash("sha256")
    .update(`honeybee-benchmark-library-only-v1\0${runToken}\0${randomUUID()}`)
    .digest("hex");
  const totalStarted = performance.now();
  const begun = await timed(() => storage.beginParent(storageCommand, parentId));
  if (begun.value.transactionId === undefined || begun.value.stagingPath === undefined) {
    throw new Error("Fresh Library-only parent unexpectedly already existed.");
  }
  try {
    const copied = await timed(async () => {
      for (const entry of await readdir(libraryPath)) {
        await cp(path.join(libraryPath, entry), path.join(begun.value.stagingPath, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
      }
    });
    const committed = await timed(() =>
      storage.commitParent(storageCommand, begun.value.transactionId),
    );
    return {
      parentId: committed.value.parentId ?? parentId,
      allocatedBytes: committed.value.allocatedBytes ?? null,
      beginMs: begun.ms,
      seedCopyMs: copied.ms,
      commitMs: committed.ms,
      totalMs: performance.now() - totalStarted,
    };
  } catch (error) {
    await storage.abortParent(storageCommand, begun.value.transactionId).catch(() => undefined);
    throw error;
  }
};

const legacyOnce = async ({ adapter, libraryParentId, index, warmup }) => {
  const suffix = warmup ? "warm" : String(index);
  const workspaceId = `hb-bench-lib-${runToken}-${suffix}`;
  const consumerId = `hb-bench-consumer-lib-${runToken}-${suffix}`;
  const workspacePath = path.join(workspaceRoot, workspaceId);
  let leaseId;
  const totalStarted = performance.now();
  try {
    const prepared = await timed(() => bootstrap.prepare(seedWorktree, workspaceRoot, workspaceId));
    const acquired = await timed(() =>
      adapter.acquire(
        {
          schemaVersion: 2,
          operation: "workspace-acquire",
          requestId: `hb-bench-acquire-lib-${runToken}-${suffix}`,
          consumerId,
          workspaceId,
          parentId: libraryParentId,
          clientPid: process.pid,
        },
        workspacePath,
      ),
    );
    leaseId = acquired.value.lease.leaseId;
    const readyMs = performance.now() - totalStarted;
    const readyStatus = await storageStatus(`hb-bench-status-lib-${runToken}-${suffix}`);
    if (!(await exists(path.join(workspacePath, "Assets")))) throw new Error("Assets missing.");
    if (!(await exists(path.join(workspacePath, "Library")))) throw new Error("Library missing.");
    return {
      mode: "library-only",
      index,
      warmup,
      readyMs,
      sourceCopyMs: prepared.ms,
      storageAcquireMs: acquired.ms,
      storageMetrics: acquired.value.metrics ?? null,
      storageAllocatedBytes:
        readyStatus.activeChildAllocatedBytes + readyStatus.retainedChildAllocatedBytes,
    };
  } finally {
    if (leaseId !== undefined) {
      await adapter.release(leaseId, `hb-bench-release-lib-${runToken}-${suffix}`, workspaceRoot);
      await bootstrap.verifyReleased(workspaceRoot, workspaceId);
    } else {
      await bootstrap.cleanupUnacquired(workspaceRoot, workspaceId).catch(() => undefined);
    }
  }
};

const fullOnce = async ({ index, warmup }) => {
  const suffix = warmup ? "warm" : String(index);
  const name = `gnf-full-${runToken}-${suffix}`;
  const branch = `hb-bench/gnf-cow-${runToken}-full-${suffix}`;
  const totalStarted = performance.now();
  let created;
  try {
    created = await core.createWorkspace({ name, branch, base: "HEAD" });
    const readyMs = performance.now() - totalStarted;
    const readyStatus = await storageStatus(`hb-bench-status-full-${runToken}-${suffix}`);
    const actualHead = await git(["rev-parse", "HEAD"], created.workspacePath);
    if (actualHead !== benchmark.head) throw new Error("Full-project workspace HEAD mismatch.");
    if (!(await exists(path.join(created.workspacePath, "Assets")))) {
      throw new Error("Full-project Assets missing.");
    }
    if (!(await exists(path.join(created.workspacePath, "Library")))) {
      throw new Error("Full-project Library missing.");
    }
    return {
      mode: "full-project",
      index,
      warmup,
      readyMs,
      storageAllocatedBytes:
        readyStatus.activeChildAllocatedBytes + readyStatus.retainedChildAllocatedBytes,
      branch,
      head: actualHead,
    };
  } finally {
    if (created !== undefined) {
      await core.removeWorkspace(created.workspaceId).catch(() => undefined);
    }
    const ref = `refs/heads/${branch}`;
    const refExists = await git(["show-ref", "--verify", "--quiet", ref])
      .then(() => true)
      .catch(() => false);
    if (refExists) await git(["branch", "-D", branch]);
  }
};

const benchmark = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  projectPath,
  storageCommand,
  workspaceRoot,
  benchmarkRoot,
  runToken,
  measuredRuns,
  libraryParentOverride: libraryParentOverride ?? null,
  fullParentOverride: fullParentOverride ?? null,
  machine: {
    platform: process.platform,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  },
  records: [],
};

let seedRegistered = false;
try {
  if (!Number.isInteger(measuredRuns) || measuredRuns < 3 || measuredRuns > 20) {
    throw new Error("Measured run count must be an integer from 3 through 20.");
  }
  await mkdir(benchmarkRoot, { recursive: false });
  await mkdir(fullLogicalRoot, { recursive: true });
  benchmark.head = await git(["rev-parse", "HEAD"]);
  benchmark.sourceBranch = await git(["branch", "--show-current"]);
  benchmark.sourceDirtyEntries = (await git(["status", "--short"]))
    .split(/\r?\n/gu)
    .filter(Boolean).length;
  benchmark.library = await treeMeasure(path.join(projectPath, "Library"));
  benchmark.storageBefore = await storageStatus(`hb-bench-before-${runToken}`);

  await git(["worktree", "add", "--detach", seedWorktree, benchmark.head]);
  seedRegistered = true;
  if ((await git(["status", "--porcelain=v1"], seedWorktree)).length !== 0) {
    throw new Error("Detached seed worktree is not clean.");
  }

  const binarySha256 = await sha256File(storageCommand);
  const adapter = new UnityWorkspaceStorageCliAdapter(
    { command: storageCommand },
    "vhdx-differencing",
    binarySha256,
    2,
  );
  await adapter.preflight();

  benchmark.libraryParent = await prepareLibraryParent(
    path.join(projectPath, "Library"),
    libraryParentOverride,
  );

  core = new HoneyBeeWorkspaceCore({ dataRoot: coreDataRoot });
  const registeredProject = await core.initProject({
    unityProjectPath: projectPath,
    workspaceRoot: fullLogicalRoot,
    storageCommand,
    label: "GNF_ CoW benchmark",
  });
  if (fullParentOverride === undefined) {
    const fullParent = await timed(() => core.prepareCache(registeredProject.projectId));
    benchmark.fullParent = {
      parentId: fullParent.value.cache.parentId,
      allocatedBytes: fullParent.value.cache.allocatedBytes ?? null,
      totalMs: fullParent.ms,
      seedCommit: fullParent.value.cache.seedCommit,
    };
  } else {
    benchmark.fullParent = {
      parentId: fullParentOverride,
      allocatedBytes: null,
      totalMs: 0,
      seedCommit: benchmark.head,
      reused: true,
    };
    const registry = await import("../packages/core/dist/index.js").then(
      ({ WorkspaceRegistryStore }) => new WorkspaceRegistryStore(coreDataRoot),
    );
    await registry.putProject({
      ...registeredProject,
      cache: {
        parentId: fullParentOverride,
        seedCommit: benchmark.head,
        preparedAt: new Date().toISOString(),
      },
    });
  }

  benchmark.records.push(
    await legacyOnce({
      adapter,
      libraryParentId: benchmark.libraryParent.parentId,
      index: -1,
      warmup: true,
    }),
  );
  benchmark.records.push(await fullOnce({ index: -1, warmup: true }));

  for (let index = 0; index < measuredRuns; index += 1) {
    const operations =
      index % 2 === 0
        ? [
            () =>
              legacyOnce({
                adapter,
                libraryParentId: benchmark.libraryParent.parentId,
                index,
                warmup: false,
              }),
            () => fullOnce({ index, warmup: false }),
          ]
        : [
            () => fullOnce({ index, warmup: false }),
            () =>
              legacyOnce({
                adapter,
                libraryParentId: benchmark.libraryParent.parentId,
                index,
                warmup: false,
              }),
          ];
    for (const operation of operations) benchmark.records.push(await operation());
  }

  benchmark.summary = {
    libraryOnly: summarize(benchmark.records, "library-only"),
    fullProject: summarize(benchmark.records, "full-project"),
  };
  benchmark.summary.medianSpeedup =
    benchmark.summary.libraryOnly.medianReadyMs / benchmark.summary.fullProject.medianReadyMs;
  benchmark.storageAfter = await storageStatus(`hb-bench-after-${runToken}`);
  benchmark.completedAt = new Date().toISOString();
} catch (error) {
  benchmark.failedAt = new Date().toISOString();
  benchmark.error =
    error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  throw error;
} finally {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
  if (seedRegistered) {
    await git(["worktree", "remove", "--force", seedWorktree]).catch(() => undefined);
  }
  await git(["worktree", "prune"]).catch(() => undefined);
  await rm(benchmarkRoot, { recursive: true, force: true }).catch(() => undefined);
}

process.stdout.write(`${JSON.stringify(benchmark.summary, null, 2)}\n`);
