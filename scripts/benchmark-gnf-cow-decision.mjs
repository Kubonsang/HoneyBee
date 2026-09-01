import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { promisify } from "node:util";

import {
  HoneyBeeWorkspaceCore,
  WindowsWorkspaceStorage,
  WorkspaceRegistryStore,
} from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const phase = process.argv[2] ?? "run";
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultOutput = path.join(
  repositoryRoot,
  "docs",
  "benchmarks",
  "gnf-cow-decision-2026-09-02",
  "raw",
  "results.json",
);
const parentEvidencePath = path.join(
  repositoryRoot,
  "docs",
  "benchmarks",
  "gnf-cow-2026-09-01",
  "raw",
  "parent-preparation.json",
);
const storage = new WindowsWorkspaceStorage();

const timed = async (operation) => {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
};

const exists = async (candidate) =>
  access(candidate)
    .then(() => true)
    .catch(() => false);

const mountState = async (candidate) => ({
  available: await stat(candidate)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
  nodeLstatVisible: await lstat(candidate)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
});

const run = async (command, args, cwd, options = {}) => {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", UNITY_NO_UPDATE_CHECK: "1" },
    ...options,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

const git = async (projectPath, args, cwd = projectPath) => {
  const safeDirectory = (await realpath(cwd).catch(() => path.resolve(cwd))).replaceAll("\\", "/");
  return (await run("git.exe", ["-c", `safe.directory=${safeDirectory}`, ...args], cwd)).stdout;
};

const storageStatus = async (storageCommand, requestId) => {
  const { stdout } = await run(
    storageCommand,
    ["workspace", "status", "--request-id", requestId],
    path.dirname(storageCommand),
  );
  return JSON.parse(stdout).status;
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const upper = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[upper - 1] + sorted[upper]) / 2 : sorted[upper];
};

const summarize = (records, field) => {
  const values = records.map((record) => record[field]);
  return {
    count: values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    raw: values,
  };
};

const treeMeasure = async (root, skipNames = new Set()) => {
  const stack = [root];
  let files = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (current === root && skipNames.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) stack.push(candidate);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { files, bytes };
};

const assertClean = async (projectPath, workspacePath, expectedHead, expectedBranch) => {
  const [head, branch, status] = await Promise.all([
    git(projectPath, ["rev-parse", "HEAD"], workspacePath),
    git(projectPath, ["branch", "--show-current"], workspacePath),
    git(projectPath, ["status", "--porcelain=v1", "--untracked-files=all"], workspacePath),
  ]);
  if (head !== expectedHead) throw new Error(`Workspace HEAD mismatch: ${head}`);
  if (branch !== expectedBranch) throw new Error(`Workspace branch mismatch: ${branch}`);
  if (status.length !== 0)
    throw new Error(`Workspace is dirty before use: ${status.slice(0, 500)}`);
};

const deleteBranch = async (projectPath, branch) => {
  const ref = `refs/heads/${branch}`;
  const present = await git(projectPath, ["show-ref", "--verify", "--quiet", ref])
    .then(() => true)
    .catch(() => false);
  if (present) await git(projectPath, ["branch", "-D", branch]);
};

const createLibraryWorkspace = async (context, label) => {
  const branch = `hb-bench/gnf-decision-${context.runToken}-a-${label}`;
  const workspaceId = `hb-ab-a-${context.runToken}-${label}`;
  const consumerId = `hb-ab-consumer-a-${context.runToken}-${label}`;
  const workspacePath = path.join(context.libraryRoot, label);
  let lease;
  let retained = false;
  let registered = false;
  const totalStarted = performance.now();
  try {
    const worktree = await timed(() =>
      git(context.projectPath, ["worktree", "add", "-b", branch, workspacePath, context.head]),
    );
    registered = true;
    const acquired = await timed(() =>
      storage.acquire(context.storageCommand, {
        consumerId,
        workspaceId,
        parentId: context.libraryParentId,
        clientPid: process.pid,
      }),
    );
    lease = acquired.value;
    const linked = await timed(() =>
      symlink(lease.mountPath, path.join(workspacePath, "Library"), "junction"),
    );
    const retainedAttached = await timed(async () => {
      await storage.retain(context.storageCommand, lease.leaseId);
      retained = true;
      return storage.attachRetained(context.storageCommand, consumerId, workspaceId);
    });
    lease = retainedAttached.value;
    const validated = await timed(() =>
      assertClean(context.projectPath, workspacePath, context.head, branch),
    );
    return {
      mode: "A-library-cow-git-worktree",
      branch,
      workspaceId,
      consumerId,
      workspacePath,
      leaseId: lease.leaseId,
      mountPath: lease.mountPath,
      createMs: performance.now() - totalStarted,
      segments: {
        gitWorktreeMs: worktree.ms,
        storageAcquireMs: acquired.ms,
        junctionMs: linked.ms,
        retainAttachMs: retainedAttached.ms,
        validationMs: validated.ms,
      },
    };
  } catch (error) {
    await unlink(path.join(workspacePath, "Library")).catch(() => undefined);
    if (retained)
      await storage.removeRetained(context.storageCommand, consumerId).catch(() => undefined);
    else if (lease !== undefined) {
      await storage.retain(context.storageCommand, lease.leaseId).catch(() => undefined);
      await storage.removeRetained(context.storageCommand, consumerId).catch(() => undefined);
    }
    if (registered) {
      await git(context.projectPath, ["worktree", "remove", "--force", workspacePath]).catch(
        () => undefined,
      );
    }
    await deleteBranch(context.projectPath, branch).catch(() => undefined);
    throw error;
  }
};

const removeLibraryWorkspace = async (context, workspace) => {
  const started = performance.now();
  await unlink(path.join(workspace.workspacePath, "Library")).catch(() => undefined);
  await storage.removeRetained(context.storageCommand, workspace.consumerId);
  await git(context.projectPath, ["worktree", "remove", "--force", workspace.workspacePath]);
  await deleteBranch(context.projectPath, workspace.branch);
  return performance.now() - started;
};

const createFullWorkspace = async (context, label) => {
  const branch = `hb-bench/gnf-decision-${context.runToken}-b-${label}`;
  const totalStarted = performance.now();
  try {
    const value = await context.core.createWorkspace({
      project: context.projectId,
      name: label,
      branch,
      base: context.head,
    });
    await assertClean(context.projectPath, value.workspacePath, context.head, branch);
    return {
      mode: "B-full-project-cow-no-rewrite",
      ...value,
      branch,
      createMs: performance.now() - totalStarted,
    };
  } catch (error) {
    await deleteBranch(context.projectPath, branch).catch(() => undefined);
    throw error;
  }
};

const removeFullWorkspace = async (context, workspace) => {
  const started = performance.now();
  await context.core.removeWorkspace(workspace.workspaceId, context.projectId);
  await deleteBranch(context.projectPath, workspace.branch);
  return performance.now() - started;
};

const discardBenchmarkChanges = async (context, workspace) => {
  const before = await git(
    context.projectPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    workspace.workspacePath,
  );
  const started = performance.now();
  if (before.length !== 0) {
    await git(
      context.projectPath,
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."],
      workspace.workspacePath,
    );
    if (before.split(/\r?\n/gu).some((entry) => entry.startsWith("?? "))) {
      await git(
        context.projectPath,
        ["clean", "-fd", "-e", "System Volume Information/"],
        workspace.workspacePath,
      );
    }
  }
  const after = await git(
    context.projectPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    workspace.workspacePath,
  );
  if (after.length !== 0) throw new Error(`Benchmark cleanup did not restore ${workspace.name}.`);
  return { before, after, ms: performance.now() - started };
};

const allocatedChildren = (status) =>
  status.activeChildAllocatedBytes + status.retainedChildAllocatedBytes;

const childCount = (status) => status.activeChildCount + status.retainedChildCount;

const measureOne = async (context, mode, label, warmup) => {
  const before = await storageStatus(
    context.storageCommand,
    `hb-ab-create-before-${context.runToken}-${mode}-${label}`,
  );
  if (childCount(before) !== 0)
    throw new Error(`Create baseline is not clean for ${mode}/${label}.`);
  const created =
    mode === "A"
      ? await createLibraryWorkspace(context, label)
      : await createFullWorkspace(context, label);
  const readyStatus = await storageStatus(
    context.storageCommand,
    `hb-ab-ready-${context.runToken}-${mode}-${label}`,
  );
  if (childCount(readyStatus) !== 1) {
    throw new Error(`Expected one child for ${mode}/${label}, got ${childCount(readyStatus)}.`);
  }
  const hostTree =
    mode === "A"
      ? await treeMeasure(created.workspacePath, new Set(["Library"]))
      : { files: 0, bytes: 0 };
  const removeMs =
    mode === "A"
      ? await removeLibraryWorkspace(context, created)
      : await removeFullWorkspace(context, created);
  const after = await storageStatus(
    context.storageCommand,
    `hb-ab-removed-${context.runToken}-${mode}-${label}`,
  );
  if (childCount(after) !== 0) throw new Error(`Child residual after ${mode}/${label}.`);
  return {
    mode,
    label,
    warmup,
    createMs: created.createMs,
    removeMs,
    childAllocatedBytes: allocatedChildren(readyStatus),
    hostWorktreeLogicalBytes: hostTree.bytes,
    hostWorktreeFiles: hostTree.files,
    estimatedWorkspaceBytes: allocatedChildren(readyStatus) + hostTree.bytes,
    hostFreeDeltaBytes: before.capacity.hostFreeBytes - readyStatus.capacity.hostFreeBytes,
    hostFreeRecoveryBytes: after.capacity.hostFreeBytes - readyStatus.capacity.hostFreeBytes,
    ...(created.segments === undefined ? {} : { segments: created.segments }),
  };
};

const cumulative = async (context, mode) => {
  const baseline = await storageStatus(
    context.storageCommand,
    `hb-ab-cumulative-before-${context.runToken}-${mode}`,
  );
  const workspaces = [];
  const checkpoints = [];
  const removals = [];
  let after;
  try {
    for (let index = 1; index <= 8; index += 1) {
      const label = `cum-${mode.toLowerCase()}-${index}`;
      workspaces.push(
        mode === "A"
          ? await createLibraryWorkspace(context, label)
          : await createFullWorkspace(context, label),
      );
      if (index === 4 || index === 8) {
        const current = await storageStatus(
          context.storageCommand,
          `hb-ab-cumulative-${context.runToken}-${mode}-${index}`,
        );
        if (childCount(current) !== index) {
          throw new Error(`Expected ${index} cumulative children for ${mode}.`);
        }
        let hostWorktreeLogicalBytes = 0;
        let hostWorktreeFiles = 0;
        if (mode === "A") {
          for (const workspace of workspaces) {
            const measured = await treeMeasure(workspace.workspacePath, new Set(["Library"]));
            hostWorktreeLogicalBytes += measured.bytes;
            hostWorktreeFiles += measured.files;
          }
        }
        checkpoints.push({
          workspaceCount: index,
          childAllocatedBytes: allocatedChildren(current),
          hostWorktreeLogicalBytes,
          hostWorktreeFiles,
          estimatedWorkspaceBytes: allocatedChildren(current) + hostWorktreeLogicalBytes,
          hostFreeDeltaBytes: baseline.capacity.hostFreeBytes - current.capacity.hostFreeBytes,
          brokerStatus: {
            activeChildCount: current.activeChildCount,
            retainedChildCount: current.retainedChildCount,
          },
        });
      }
    }
  } finally {
    for (const workspace of workspaces.reverse()) {
      const removeMs =
        mode === "A"
          ? await removeLibraryWorkspace(context, workspace)
          : await removeFullWorkspace(context, workspace);
      removals.push(removeMs);
    }
    after = await storageStatus(
      context.storageCommand,
      `hb-ab-cumulative-after-${context.runToken}-${mode}`,
    );
  }
  if (childCount(after) !== 0) throw new Error(`Cumulative cleanup residual for ${mode}.`);
  return { mode, checkpoints, removalMs: removals };
};

const unityReady = async (context, mode, index) => {
  const label = `unity-${mode.toLowerCase()}-${index}`;
  const workspace =
    mode === "A"
      ? await createLibraryWorkspace(context, label)
      : await createFullWorkspace(context, label);
  const logPath = path.join(context.logsRoot, `${label}.log`);
  const started = performance.now();
  let exitCode = 0;
  let commandError;
  try {
    await run(
      context.unityEditor,
      [
        "-batchmode",
        "-nographics",
        "-quit",
        "-projectPath",
        workspace.workspacePath,
        "-logFile",
        logPath,
      ],
      path.dirname(context.unityEditor),
      { timeout: 15 * 60_000 },
    );
  } catch (error) {
    commandError = error;
    exitCode = error.code ?? 1;
  }
  const readyMs = performance.now() - started;
  const log = await readFile(logPath, "utf8").catch(() => "");
  const compilerErrors = log.match(/error CS\d{4}|Scripts have compiler errors/giu) ?? [];
  const successMarker = /Exiting batchmode successfully now!/u.test(log);
  const workspaceStatus = await git(
    context.projectPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    workspace.workspacePath,
  );
  const afterUnity = await storageStatus(
    context.storageCommand,
    `hb-ab-unity-ready-${context.runToken}-${mode}-${index}`,
  );
  const result = {
    mode,
    index,
    unityReadyMs: readyMs,
    exitCode,
    successMarker,
    compilerErrorCount: compilerErrors.length,
    trackedStatusAfterUnity: workspaceStatus,
    childAllocatedBytesAfterUnity: allocatedChildren(afterUnity),
    logSha256: createHash("sha256").update(log).digest("hex"),
  };
  const gitCleanup = await discardBenchmarkChanges(context, workspace);
  const removeMs =
    mode === "A"
      ? await removeLibraryWorkspace(context, workspace)
      : await removeFullWorkspace(context, workspace);
  result.gitCleanup = gitCleanup;
  result.removeMs = removeMs;
  if (commandError !== undefined || !successMarker || compilerErrors.length !== 0) {
    throw new Error(`Unity ready failed for ${mode}/${index}: ${JSON.stringify(result)}`);
  }
  return result;
};

const configureFullCore = async (context) => {
  context.core = new HoneyBeeWorkspaceCore({ dataRoot: context.coreDataRoot });
  const project = await context.core.initProject({
    unityProjectPath: context.projectPath,
    workspaceRoot: context.fullLogicalRoot,
    storageCommand: context.storageCommand,
    label: "GNF_ CoW decision benchmark",
  });
  context.projectId = project.projectId;
  const registry = new WorkspaceRegistryStore(context.coreDataRoot);
  await registry.putProject({
    ...project,
    cache: {
      parentId: context.fullParentId,
      seedCommit: context.head,
      preparedAt: new Date().toISOString(),
    },
  });
};

const writeBenchmark = async (outputPath, benchmark) => {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
};

const finishPreReboot = async (context, benchmark, unityRuns) => {
  const completedUnity = new Set(
    benchmark.unityReady.map((record) => `${record.mode}:${record.index}`),
  );
  for (let index = 0; index < unityRuns; index += 1) {
    const modes = index % 2 === 0 ? ["A", "B"] : ["B", "A"];
    for (const mode of modes) {
      if (completedUnity.has(`${mode}:${index}`)) continue;
      benchmark.unityReady.push(await unityReady(context, mode, index));
      await writeBenchmark(context.outputPath, benchmark);
    }
  }

  const measuredA = benchmark.createRemove.filter(
    (record) => record.mode === "A" && !record.warmup,
  );
  const measuredB = benchmark.createRemove.filter(
    (record) => record.mode === "B" && !record.warmup,
  );
  benchmark.summary = {
    A: {
      createMs: summarize(measuredA, "createMs"),
      removeMs: summarize(measuredA, "removeMs"),
      childAllocatedBytes: summarize(measuredA, "childAllocatedBytes"),
      estimatedWorkspaceBytes: summarize(measuredA, "estimatedWorkspaceBytes"),
      hostFreeDeltaBytes: summarize(measuredA, "hostFreeDeltaBytes"),
      unityReadyMs: summarize(
        benchmark.unityReady.filter((record) => record.mode === "A"),
        "unityReadyMs",
      ),
    },
    B: {
      createMs: summarize(measuredB, "createMs"),
      removeMs: summarize(measuredB, "removeMs"),
      childAllocatedBytes: summarize(measuredB, "childAllocatedBytes"),
      estimatedWorkspaceBytes: summarize(measuredB, "estimatedWorkspaceBytes"),
      hostFreeDeltaBytes: summarize(measuredB, "hostFreeDeltaBytes"),
      unityReadyMs: summarize(
        benchmark.unityReady.filter((record) => record.mode === "B"),
        "unityReadyMs",
      ),
    },
  };

  const rebootA = await createLibraryWorkspace(context, "reboot-a");
  const rebootB = await createFullWorkspace(context, "reboot-b");
  const beforeReboot = await storageStatus(
    context.storageCommand,
    `hb-ab-reboot-before-${context.runToken}`,
  );
  if (childCount(beforeReboot) !== 2 || beforeReboot.retainedChildCount !== 2) {
    throw new Error("Reboot checkpoint requires two retained children.");
  }
  const checkpointPath = path.join(context.benchmarkRoot, "reboot-checkpoint.json");
  const checkpoint = {
    schemaVersion: 1,
    outputPath: context.outputPath,
    repositoryRoot,
    benchmarkRoot: context.benchmarkRoot,
    projectPath: context.projectPath,
    storageCommand: context.storageCommand,
    runToken: context.runToken,
    head: context.head,
    libraryParentId: context.libraryParentId,
    fullParentId: context.fullParentId,
    libraryRoot: context.libraryRoot,
    fullLogicalRoot: context.fullLogicalRoot,
    coreDataRoot: context.coreDataRoot,
    projectId: context.projectId,
    bootSessionBefore: beforeReboot.bootSessionId,
    A: rebootA,
    B: rebootB,
  };
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  benchmark.phase = "pre-reboot-complete";
  benchmark.reboot = { status: "awaiting-actual-reboot", checkpoint: "<local-checkpoint>" };
  benchmark.completedPreRebootAt = new Date().toISOString();
  await writeBenchmark(context.outputPath, benchmark);
  process.stdout.write(
    `${JSON.stringify({ summary: benchmark.summary, checkpointPath, bootSessionBefore: beforeReboot.bootSessionId }, null, 2)}\n`,
  );
};

const runMain = async () => {
  const projectPath = path.resolve(process.argv[3] ?? "C:/Users/user/DEV/Task_Allocator/GNF_");
  const storageCommand = path.resolve(
    process.argv[4] ?? "apps/desktop/.tools/win32-x64/unity-workspace-storage.exe",
  );
  const outputPath = path.resolve(process.argv[5] ?? defaultOutput);
  const libraryParentId = process.argv[6];
  const fullParentId = process.argv[7];
  const createRuns = Number.parseInt(process.argv[8] ?? "20", 10);
  const unityRuns = Number.parseInt(process.argv[9] ?? "3", 10);
  const preflightOnly = process.env.HONEYBEE_COW_PREFLIGHT === "1";
  if (libraryParentId === undefined || fullParentId === undefined) {
    throw new Error("run requires Library and full-project parent IDs.");
  }
  if (createRuns !== (preflightOnly ? 1 : 20)) {
    throw new Error(
      preflightOnly
        ? "Preflight requires exactly one create sample."
        : "Decision benchmark requires exactly 20 create samples.",
    );
  }
  if (unityRuns < 1 || unityRuns > 5) throw new Error("Unity sample count must be 1 through 5.");

  const runToken = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/gu, "")
    .slice(0, 14);
  const benchmarkRoot = path.join("C:/tmp", `HoneyBee-GNF-CoW-Decision-${runToken}`);
  const context = {
    projectPath,
    storageCommand,
    outputPath,
    libraryParentId,
    fullParentId,
    runToken,
    benchmarkRoot,
    libraryRoot: path.join(benchmarkRoot, "library-worktrees"),
    fullLogicalRoot: path.join(benchmarkRoot, "full-workspaces"),
    coreDataRoot: path.join(benchmarkRoot, "core-data"),
    logsRoot: path.join(benchmarkRoot, "unity-logs"),
    unityEditor: "C:/Program Files/Unity/Hub/Editor/6000.3.8f1/Editor/Unity.exe",
  };
  await Promise.all([
    mkdir(context.libraryRoot, { recursive: true }),
    mkdir(context.fullLogicalRoot, { recursive: true }),
    mkdir(context.logsRoot, { recursive: true }),
  ]);
  context.head = await git(projectPath, ["rev-parse", "HEAD"]);
  const sourceBranch = await git(projectPath, ["branch", "--show-current"]);
  const sourceDirty = (await git(projectPath, ["status", "--porcelain=v1"]))
    .split(/\r?\n/gu)
    .filter(Boolean).length;
  const parentEvidence = JSON.parse(await readFile(parentEvidencePath, "utf8"));
  if (
    parentEvidence.libraryOnly.parentId !== libraryParentId ||
    parentEvidence.fullProject.parentId !== fullParentId ||
    parentEvidence.source.commit !== context.head
  ) {
    throw new Error("Parent preparation evidence does not match this experiment.");
  }
  if (!(await exists(context.unityEditor)))
    throw new Error("Required Unity 6000.3.8f1 is missing.");
  await configureFullCore(context);

  const benchmark = {
    schemaVersion: 1,
    phase: "running-pre-reboot",
    startedAt: new Date().toISOString(),
    source: {
      project: "GNF_",
      head: context.head,
      branch: sourceBranch,
      dirtyEntries: sourceDirty,
    },
    machine: {
      platform: process.platform,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      unityEditorVersion: "6000.3.8f1",
    },
    experiment: {
      createRuns,
      unityRuns,
      preflightOnly,
      parentPreparationProvenance: "same immutable GNF_ parents measured fresh on 2026-09-01",
      decisionRule: {
        correctness:
          "Both modes must complete 20/20 creates, Unity ready, remove, and reboot repair.",
        primary: ["create median", "8-workspace host free delta", "Unity-ready median"],
        fullProjectPass:
          "B must win at least two primary metrics and be no more than 10% slower on the third; remove and reboot repair must also be no more than 10% slower.",
      },
    },
    parents: parentEvidence,
    parentReuseValidation: {},
    createRemove: [],
    cumulative: [],
    unityReady: [],
  };
  const statusBefore = await storageStatus(storageCommand, `hb-ab-before-${runToken}`);
  if (childCount(statusBefore) !== 0 || statusBefore.quarantineCount !== 0) {
    throw new Error("Broker must start with zero child/quarantine residuals.");
  }
  benchmark.storageBefore = statusBefore;
  benchmark.parentReuseValidation.A = await timed(() =>
    storage.beginParent(storageCommand, libraryParentId),
  );
  benchmark.parentReuseValidation.B = await timed(() =>
    storage.beginParent(storageCommand, fullParentId),
  );
  if (
    benchmark.parentReuseValidation.A.value.transactionId !== undefined ||
    benchmark.parentReuseValidation.B.value.transactionId !== undefined
  ) {
    throw new Error("Expected both immutable parents to be reusable.");
  }
  await writeBenchmark(outputPath, benchmark);

  benchmark.createRemove.push(await measureOne(context, "A", "warm", true));
  benchmark.createRemove.push(await measureOne(context, "B", "warm", true));
  for (let index = 0; index < createRuns; index += 1) {
    const modes = index % 2 === 0 ? ["A", "B"] : ["B", "A"];
    for (const mode of modes) {
      benchmark.createRemove.push(
        await measureOne(context, mode, `sample-${index.toString().padStart(2, "0")}`, false),
      );
      await writeBenchmark(outputPath, benchmark);
    }
  }

  if (preflightOnly) {
    const storageAfter = await storageStatus(storageCommand, `hb-ab-preflight-after-${runToken}`);
    if (childCount(storageAfter) !== 0 || storageAfter.quarantineCount !== 0) {
      throw new Error("Preflight cleanup left broker residuals.");
    }
    benchmark.phase = "preflight-complete";
    benchmark.storageAfter = storageAfter;
    benchmark.completedAt = new Date().toISOString();
    await writeBenchmark(outputPath, benchmark);
    await rm(benchmarkRoot, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify(benchmark.createRemove, null, 2)}\n`);
    return;
  }

  benchmark.cumulative.push(await cumulative(context, "A"));
  await writeBenchmark(outputPath, benchmark);
  benchmark.cumulative.push(await cumulative(context, "B"));
  await writeBenchmark(outputPath, benchmark);

  await finishPreReboot(context, benchmark, unityRuns);
};

const resumePreReboot = async () => {
  const outputPath = path.resolve(process.argv[3] ?? "");
  const benchmarkRoot = path.resolve(process.argv[4] ?? "");
  const projectPath = path.resolve(process.argv[5] ?? "");
  const storageCommand = path.resolve(process.argv[6] ?? "");
  const libraryParentId = process.argv[7];
  const fullParentId = process.argv[8];
  const unityRuns = Number.parseInt(process.argv[9] ?? "3", 10);
  const interruptedStatusEvidence = process.argv[10] ?? "";
  if (
    !(await exists(outputPath)) ||
    !(await exists(benchmarkRoot)) ||
    libraryParentId === undefined ||
    fullParentId === undefined
  ) {
    throw new Error(
      "resume-pre-reboot requires the result, root, project, broker, and parent IDs.",
    );
  }
  const prefix = "HoneyBee-GNF-CoW-Decision-";
  const rootName = path.basename(benchmarkRoot);
  if (!rootName.startsWith(prefix)) throw new Error("Unexpected benchmark root.");
  const runToken = rootName.slice(prefix.length);
  const benchmark = JSON.parse(await readFile(outputPath, "utf8"));
  if (benchmark.createRemove.length !== 42 || benchmark.cumulative.length !== 2) {
    throw new Error("The interrupted result did not finish create/remove and cumulative phases.");
  }
  const context = {
    projectPath,
    storageCommand,
    outputPath,
    libraryParentId,
    fullParentId,
    runToken,
    benchmarkRoot,
    libraryRoot: path.join(benchmarkRoot, "library-worktrees"),
    fullLogicalRoot: path.join(benchmarkRoot, "full-workspaces"),
    coreDataRoot: path.join(benchmarkRoot, "core-data"),
    logsRoot: path.join(benchmarkRoot, "unity-logs"),
    unityEditor: "C:/Program Files/Unity/Hub/Editor/6000.3.8f1/Editor/Unity.exe",
    head: benchmark.source.head,
  };
  if ((await git(projectPath, ["rev-parse", "HEAD"])) !== context.head) {
    throw new Error("GNF_ HEAD changed after the interrupted run.");
  }
  await configureFullCore(context);
  const registry = new WorkspaceRegistryStore(context.coreDataRoot);
  const registered = await registry.read();
  for (const workspace of registered.workspaces) {
    const relative = path.relative(context.fullLogicalRoot, workspace.workspacePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !workspace.branch.startsWith(`hb-bench/gnf-decision-${runToken}-b-unity-`)
    ) {
      throw new Error("Refusing to clean a workspace outside the interrupted benchmark.");
    }
    const beforeCleanup = await storageStatus(
      storageCommand,
      `hb-ab-interrupted-before-${runToken}-${workspace.name}`,
    );
    const gitCleanup = await discardBenchmarkChanges(context, workspace);
    const removeMs = await removeFullWorkspace(context, workspace);
    benchmark.interruptions ??= [];
    benchmark.interruptions.push({
      stage: "unity-removal",
      mode: "B",
      workspace: workspace.name,
      error: "workspace.dirty",
      trackedStatusAfterUnity: gitCleanup.before || interruptedStatusEvidence,
      statusEvidenceSource:
        gitCleanup.before.length === 0 && interruptedStatusEvidence.length !== 0
          ? "captured-before-first-resume-attempt"
          : "resume-cleanup",
      childAllocatedBytesAfterUnity: allocatedChildren(beforeCleanup),
      cleanupPreparationMs: gitCleanup.ms,
      removeMs,
    });
  }
  const cleanStatus = await storageStatus(storageCommand, `hb-ab-resume-clean-${runToken}`);
  if (childCount(cleanStatus) !== 0 || cleanStatus.quarantineCount !== 0) {
    throw new Error("Interrupted Unity workspace cleanup left broker residuals.");
  }
  benchmark.phase = "running-pre-reboot";
  await writeBenchmark(outputPath, benchmark);
  await finishPreReboot(context, benchmark, unityRuns);
};

const finalizeFailedReboot = async () => {
  const checkpointPath = path.resolve(process.argv[3] ?? "");
  const failureCode = process.argv[4] ?? "unknown-repair-failure";
  if (!(await exists(checkpointPath))) {
    throw new Error("finalize-failed-reboot requires a checkpoint path.");
  }
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  const benchmark = JSON.parse(await readFile(checkpoint.outputPath, "utf8"));
  const context = {
    ...checkpoint,
    unityEditor: "C:/Program Files/Unity/Hub/Editor/6000.3.8f1/Editor/Unity.exe",
  };
  const beforeCleanup = await storageStatus(
    context.storageCommand,
    `hb-ab-failed-reboot-before-cleanup-${context.runToken}`,
  );
  if (
    beforeCleanup.bootSessionId === checkpoint.bootSessionBefore ||
    beforeCleanup.retainedChildCount !== 2
  ) {
    throw new Error("Failed-reboot cleanup preconditions do not match the checkpoint.");
  }

  const assertBenchmarkPath = (root, candidate) => {
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Refusing cleanup outside the benchmark root.");
    }
  };
  const cleanupA = await timed(async () => {
    assertBenchmarkPath(context.libraryRoot, checkpoint.A.workspacePath);
    await rm(path.join(checkpoint.A.workspacePath, "Library"), {
      recursive: true,
      force: true,
    });
    await storage.removeRetained(context.storageCommand, checkpoint.A.consumerId);
    await git(context.projectPath, ["worktree", "remove", "--force", checkpoint.A.workspacePath]);
    await deleteBranch(context.projectPath, checkpoint.A.branch);
  });
  const cleanupB = await timed(async () => {
    assertBenchmarkPath(context.fullLogicalRoot, checkpoint.B.workspacePath);
    await storage.removeRetained(context.storageCommand, checkpoint.B.consumerId);
    await rm(checkpoint.B.workspacePath, { recursive: true, force: true });
    await git(context.projectPath, [
      "worktree",
      "remove",
      "--force",
      checkpoint.B.workspacePath,
    ]).catch(() => undefined);
    await git(context.projectPath, ["worktree", "prune", "--expire", "now"]);
    await deleteBranch(context.projectPath, checkpoint.B.branch);
  });
  const storageAfter = await storageStatus(
    context.storageCommand,
    `hb-ab-failed-reboot-after-cleanup-${context.runToken}`,
  );
  if (
    childCount(storageAfter) !== 0 ||
    storageAfter.pendingCount !== 0 ||
    storageAfter.quarantineCount !== 0 ||
    storageAfter.manualRecoveryRequired
  ) {
    throw new Error("Failed-reboot cleanup did not return the broker to zero.");
  }
  benchmark.reboot = {
    status: "failed",
    code: failureCode,
    bootSessionBefore: checkpoint.bootSessionBefore,
    bootSessionAfter: beforeCleanup.bootSessionId,
    retainedChildrenObserved: beforeCleanup.retainedChildCount,
    A: { repair: "failed", cleanupMs: cleanupA.ms },
    B: { repair: "not-measured-after-A-failure", cleanupMs: cleanupB.ms },
  };
  benchmark.storageAfter = storageAfter;
  benchmark.phase = "complete-with-repair-failure";
  benchmark.completedAt = new Date().toISOString();
  await writeBenchmark(checkpoint.outputPath, benchmark);
  await rm(checkpoint.benchmarkRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ reboot: benchmark.reboot, storageAfter }, null, 2)}\n`);
};

const resumeReboot = async () => {
  const checkpointPath = path.resolve(process.argv[3] ?? "");
  const initialRepairFailure = process.argv[4];
  if (!(await exists(checkpointPath))) throw new Error("resume-reboot requires a checkpoint path.");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  const benchmark = JSON.parse(await readFile(checkpoint.outputPath, "utf8"));
  const context = {
    ...checkpoint,
    unityEditor: "C:/Program Files/Unity/Hub/Editor/6000.3.8f1/Editor/Unity.exe",
  };
  await configureFullCore(context);
  const afterBoot = await storageStatus(
    context.storageCommand,
    `hb-ab-reboot-after-${context.runToken}`,
  );
  if (afterBoot.bootSessionId === checkpoint.bootSessionBefore) {
    throw new Error(
      "Windows boot session did not change; refusing to label this as reboot repair.",
    );
  }
  if (afterBoot.retainedChildCount !== 2) {
    throw new Error(
      `Expected two retained children after reboot, got ${afterBoot.retainedChildCount}.`,
    );
  }

  const repairA = await timed(async () => {
    const preMount = await mountState(checkpoint.A.mountPath);
    let staleShellRemoved = false;
    if (!preMount.available) {
      const expectedMountPath = path.join(
        process.env.LOCALAPPDATA ?? "",
        "HoneyBee",
        "Workspaces",
        checkpoint.A.workspaceId,
        "Library",
      );
      if (path.resolve(checkpoint.A.mountPath) !== path.resolve(expectedMountPath)) {
        throw new Error("Refusing to remove an unexpected stale A mount path.");
      }
      await rm(checkpoint.A.mountPath, { recursive: true, force: true });
      staleShellRemoved = true;
    }
    const attached = await storage.attachRetained(
      context.storageCommand,
      checkpoint.A.consumerId,
      checkpoint.A.workspaceId,
    );
    if (!(await exists(path.join(checkpoint.A.workspacePath, "Library")))) {
      await symlink(
        attached.mountPath,
        path.join(checkpoint.A.workspacePath, "Library"),
        "junction",
      );
    }
    await git(context.projectPath, ["worktree", "repair", checkpoint.A.workspacePath]);
    await assertClean(
      context.projectPath,
      checkpoint.A.workspacePath,
      context.head,
      checkpoint.A.branch,
    );
    return { attached, preMount, staleShellRemoved };
  });
  const repairB = await timed(async () => {
    const preMount = await mountState(checkpoint.B.mountPath);
    const repaired = await context.core.repairWorkspace(
      checkpoint.B.workspaceId,
      context.projectId,
    );
    return { repaired, preMount };
  });
  await assertClean(
    context.projectPath,
    checkpoint.B.workspacePath,
    context.head,
    checkpoint.B.branch,
  );

  benchmark.reboot = {
    status: "measured",
    ...(initialRepairFailure === undefined
      ? {}
      : { initialAttempt: { status: "failed", code: initialRepairFailure, mode: "A" } }),
    bootSessionBefore: checkpoint.bootSessionBefore,
    bootSessionAfter: afterBoot.bootSessionId,
    A: {
      repairMs: repairA.ms,
      available: true,
      preMount: repairA.value.preMount,
      staleShellRemoved: repairA.value.staleShellRemoved,
    },
    B: {
      repairMs: repairB.ms,
      available: repairB.value.repaired.available,
      preMount: repairB.value.preMount,
    },
  };
  await removeLibraryWorkspace(context, checkpoint.A);
  await removeFullWorkspace(context, checkpoint.B);
  const storageAfter = await storageStatus(
    context.storageCommand,
    `hb-ab-final-after-${context.runToken}`,
  );
  if (
    childCount(storageAfter) !== 0 ||
    storageAfter.pendingCount !== 0 ||
    storageAfter.quarantineCount !== 0 ||
    storageAfter.manualRecoveryRequired
  ) {
    throw new Error("Final broker cleanup is not zero.");
  }
  benchmark.storageAfter = storageAfter;
  benchmark.phase = "complete";
  benchmark.completedAt = new Date().toISOString();
  await writeBenchmark(checkpoint.outputPath, benchmark);
  await rm(checkpoint.benchmarkRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ reboot: benchmark.reboot, storageAfter }, null, 2)}\n`);
};

try {
  if (phase === "run") await runMain();
  else if (phase === "resume-pre-reboot") await resumePreReboot();
  else if (phase === "finalize-failed-reboot") await finalizeFailedReboot();
  else if (phase === "resume-reboot") await resumeReboot();
  else {
    throw new Error(
      "usage: benchmark-gnf-cow-decision.mjs run|resume-pre-reboot|finalize-failed-reboot|resume-reboot ...",
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
