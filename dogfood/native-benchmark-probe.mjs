#!/usr/bin/env node
/* global Buffer, process, setTimeout */

import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  captureAgentLaunchTrust,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunRepository,
} from "../packages/core/dist/index.js";
import { HoneyBeeRuntimeFacade } from "../apps/cli/dist/runtime-api.js";
import { UnityAgentProcessRunner } from "../apps/cli/dist/unity-adapters.js";
import { readRecoveredImmutableFile } from "../apps/cli/dist/immutable-publication.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEMO_AGENT = path.join(REPO_ROOT, "apps", "cli", "dist", "demo-agent.js");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const readJson = async (filePath) => JSON.parse(await readFile(path.resolve(filePath), "utf8"));

const writeJsonStable = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(value, null, 2) + "\n";
  try {
    await writeFile(filePath, serialized, { flag: "wx" });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Existing benchmark config is not a regular private file.");
  }
  if ((await readFile(filePath, "utf8")) !== serialized) {
    throw new Error("Existing benchmark config differs from the pinned sample config.");
  }
};

const terminalDetail = async (runtime, runId, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await runtime.getRunDetail(runId);
    if (detail.summary.terminal || detail.summary.status === "indeterminate") return detail;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Benchmark Run ${runId} did not become terminal within ${timeoutMs} ms.`);
};

class MeasuringAgentRunner {
  constructor() {
    this.inner = new UnityAgentProcessRunner();
    this.activationMs = undefined;
  }

  async run(request, lifecycle) {
    const startedAt = performance.now();
    return this.inner.run(request, {
      ...lifecycle,
      onStarted: async (pid, metadata) => {
        this.activationMs = performance.now() - startedAt;
        await lifecycle.onStarted(pid, metadata);
      },
    });
  }
}

export const benchmarkConfig = async (baseConfigPath, targetPath) => {
  const config = await readJson(baseConfigPath);
  if (![3, 4].includes(config.schemaVersion) || config.mode !== "unity-batch") {
    throw new Error("The benchmark requires a v0.6 schema-3 or schema-4 Unity batch config.");
  }
  if (config.transaction === null || typeof config.transaction !== "object") {
    throw new Error("The benchmark batch config has no transaction.");
  }
  const trust = await captureAgentLaunchTrust([
    { role: "entrypoint", path: process.execPath },
    { role: "payload", path: DEMO_AGENT },
  ]);
  const runtimeAgent = {
    command: { command: process.execPath, args: [DEMO_AGENT, "native-baseline"] },
    trust,
    harness: "stdio-framed-v2",
    adapter: "stdio-framed-v2",
    timeoutMs: 120_000,
    maxOutputBytes: 1024 * 1024,
  };
  const configAgent = {
    command: runtimeAgent.command,
    harness: runtimeAgent.harness,
    timeoutMs: runtimeAgent.timeoutMs,
    maxOutputBytes: runtimeAgent.maxOutputBytes,
  };
  const output = {
    ...config,
    transaction: { ...config.transaction, agent: configAgent },
  };
  if (config.schemaVersion === 4) {
    output.works = config.works.map((work) => ({ ...work, agent: runtimeAgent }));
  }
  await writeJsonStable(targetPath, output);
  return { config: output, runtimeAgent };
};

const runUnitySample = async (requestPath) => {
  const request = await readJson(requestPath);
  const stateRoot = path.resolve(request.stateRoot);
  const configPath = path.join(path.dirname(path.resolve(requestPath)), "benchmark-config.json");
  const benchmark = await benchmarkConfig(request.batchConfigPath, configPath);
  const config = benchmark.config;
  const projectPath = path.resolve(request.projectPath);
  const configured = path.resolve(config.transaction.sourceProjectPath);
  if (
    process.platform === "win32"
      ? projectPath.toLowerCase() !== configured.toLowerCase()
      : projectPath !== configured
  ) {
    throw new Error("Benchmark projectPath does not match the batch config sourceProjectPath.");
  }
  const runner = new MeasuringAgentRunner();
  const runtime = new HoneyBeeRuntimeFacade({ stateRoot, agentRunner: runner });
  const existing = await runtime.listRuns({ projectPath });
  if (existing.length > 1) {
    throw new Error("A benchmark sample state root contains more than one Run.");
  }
  let runId;
  let journalPath;
  if (existing[0] === undefined) {
    const started = await runtime.startUnityWorks({
      schemaVersion: 2,
      batchConfigPath: configPath,
      projectPath,
      maxParallelWorks: 1,
      works: [
        {
          id: "native-baseline",
          task: "Benchmark activation only. Make no changes and return a completed response.",
          priority: "background",
          capabilities: [],
          agent: benchmark.runtimeAgent,
        },
      ],
    });
    runId = started.runId;
    journalPath = started.journalPath;
  } else {
    runId = existing[0].runId;
    journalPath = path.join(stateRoot, runId, "events.jsonl");
    const detail = await runtime.getRunDetail(runId);
    if (
      !detail.summary.terminal &&
      detail.summary.status !== "indeterminate" &&
      !detail.summary.executorPresent
    ) {
      if (!detail.summary.allowedActions.includes("resume")) {
        throw new Error("Interrupted benchmark Run is not safely resumable.");
      }
      await runtime.resume(runId);
    }
  }
  const detail = await terminalDetail(runtime, runId, request.timeoutMs ?? 30 * 60_000);
  return {
    schemaVersion: 1,
    runId,
    journalPath,
    status: detail.summary.status,
    terminal: detail.summary.terminal,
    phase: detail.summary.phase,
    stdioProcessActivationMs: runner.activationMs,
  };
};

const timed = async (operation) => {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
};

const primitiveSamples = async (root, repetitions) => {
  const rawFsync = [];
  const journalAppend = [];
  const artifactPut = [];
  const immutablePublication = [];
  await mkdir(root, { recursive: true });
  for (let index = 0; index < repetitions; index += 1) {
    const rawPath = path.join(root, `raw-${index}.bin`);
    rawFsync.push(
      await timed(async () => {
        const handle = await open(rawPath, "wx");
        try {
          await handle.writeFile("honeybee-native-benchmark-v1", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }),
    );

    const journalRoot = path.join(root, `journal-${index}`);
    const journalRun = randomUUID();
    await new FileRunRepository(journalRoot).create(journalRun);
    journalAppend.push(
      await timed(() =>
        new FileOrchestrationJournal(journalRoot).append(journalRun, {
          schemaVersion: 1,
          eventId: randomUUID(),
          runId: journalRun,
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "workflow.started",
          payload: { stepCount: 2 },
        }),
      ),
    );

    const artifactRoot = path.join(root, `artifact-${index}`);
    const artifactRun = randomUUID();
    await new FileRunRepository(artifactRoot).create(artifactRun);
    artifactPut.push(
      await timed(() =>
        new FileArtifactStore(artifactRoot).put({
          runId: artifactRun,
          artifactId: randomUUID(),
          kind: "agent-context-content",
          mediaType: "application/json",
          content: JSON.stringify({ schemaVersion: 1, sample: index }),
        }),
      ),
    );

    const publicationRoot = path.join(root, `publication-${index}`);
    await mkdir(publicationRoot);
    const temporaryName = `.${randomUUID()}.tmp`;
    const temporaryPath = path.join(publicationRoot, temporaryName);
    const finalPath = path.join(publicationRoot, "receipt.json");
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, nonce: randomUUID() }));
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    immutablePublication.push(
      await timed(async () => {
        await link(temporaryPath, finalPath);
        const recovered = await readRecoveredImmutableFile(
          finalPath,
          (name) => /^\.[0-9a-f-]{36}\.tmp$/u.test(name),
          4096,
        );
        if (sha256(recovered.bytes) !== sha256(bytes)) {
          throw new Error("Immutable publication verification returned different bytes.");
        }
      }),
    );
  }
  return {
    schemaVersion: 1,
    repetitions,
    rawFsync,
    journalAppend,
    artifactPut,
    immutablePublication,
  };
};

const main = async () => {
  const [command, argument, repetitionsValue] = process.argv.slice(2);
  if (command === "unity" && argument !== undefined) return runUnitySample(argument);
  if (command === "primitives" && argument !== undefined) {
    const repetitions = Number.parseInt(repetitionsValue ?? "20", 10);
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 200) {
      throw new Error("Primitive repetitions must be between 1 and 200.");
    }
    const root = path.resolve(argument);
    await rm(root, { recursive: true, force: true });
    try {
      return await primitiveSamples(root, repetitions);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  throw new Error(
    "usage: node dogfood/native-benchmark-probe.mjs unity <request.json> | primitives <root> [repetitions]",
  );
};

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(JSON.stringify(await main()) + "\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
