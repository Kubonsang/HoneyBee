import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ContentDigestSchema,
  HoneyBeeCoreError,
  type AgentCommand,
  type AgentExitObservation,
  type ContentDigest,
  type RunId,
  type UnityWorkConfigV1,
  type UnityWorkspaceParentKey,
} from "@honeybee/core";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const SOURCE_DIRECTORIES = ["Assets", "Packages", "ProjectSettings"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const digestOf = (bytes: Buffer): ContentDigest =>
  ContentDigestSchema.parse("sha256:" + createHash("sha256").update(bytes).digest("hex"));

const parseOneJson = (serialized: string, name: string): unknown => {
  const trimmed = serialized.trim();
  if (trimmed.length === 0) throw new Error(name + " returned empty stdout.");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(name + " stdout was not one JSON value.");
  }
};

export interface CommandResult extends AgentExitObservation {
  readonly stdout: string;
  readonly stderr: string;
  readonly termination: "exited" | "timed-out" | "output-limit" | "cancelled";
}

interface CommandLifecycle {
  readonly onStarted?: (pid: number) => Promise<void>;
  readonly onExited?: (observation: AgentExitObservation) => Promise<void>;
}

const runCommand = (
  command: AgentCommand,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    input?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    lifecycle?: CommandLifecycle;
    environment?: Readonly<Record<string, string>>;
  }>,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command.command, [...(command.args ?? []), ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...command.env, ...options.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let termination: CommandResult["termination"] = "exited";
    let startBarrier: Promise<void> = Promise.resolve();
    let forcedTermination: ReturnType<typeof setTimeout> | undefined;

    const terminate = (reason: CommandResult["termination"]): void => {
      if (termination === "exited") termination = reason;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        forcedTermination ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000);
      }
    };
    const onAbort = (): void => terminate("cancelled");
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => terminate("timed-out"), options.timeoutMs);
    const collect = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stdout") {
        stdoutBytes += bytes.byteLength;
        stdoutHash.update(bytes);
      } else {
        stderrBytes += bytes.byteLength;
        stderrHash.update(bytes);
      }
      if (stdoutBytes + stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminate("output-limit");
        return;
      }
      target.push(bytes);
    };
    child.stdout.on("data", (chunk: Buffer | string) => collect(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => collect(stderr, "stderr", chunk));

    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) return;
      startBarrier = (options.lifecycle?.onStarted?.(pid) ?? Promise.resolve()).then(
        () =>
          new Promise<void>((writeResolve, writeReject) => {
            if (options.input === undefined) {
              child.stdin.end(writeResolve);
              return;
            }
            child.stdin.once("error", writeReject);
            child.stdin.end(options.input, "utf8", writeResolve);
          }),
      );
      void startBarrier.catch(() => terminate("cancelled"));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
      options.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        try {
          await startBarrier;
          const observation: AgentExitObservation = {
            pid: child.pid ?? -1,
            exitCode,
            signal,
            durationMs: Date.now() - startedAt,
            stdoutBytes,
            stderrBytes,
            stdoutDigest: ContentDigestSchema.parse("sha256:" + stdoutHash.digest("hex")),
            stderrDigest: ContentDigestSchema.parse("sha256:" + stderrHash.digest("hex")),
          };
          await options.lifecycle?.onExited?.(observation);
          resolve({
            ...observation,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            termination,
          });
        } catch (error) {
          reject(error);
        }
      })();
    });
  });

export interface SourceManifest {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly assetsDigest: string;
  readonly packagesDigest: string;
  readonly projectSettingsDigest: string;
  readonly fileCount: number;
  readonly logicalBytes: number;
}

interface TreeManifest {
  readonly digest: string;
  readonly fileCount: number;
  readonly logicalBytes: number;
}

const realDirectory = async (directory: string, name: string): Promise<void> => {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new HoneyBeeCoreError("workspace.invalid-project", name + " must be a real directory.");
  }
};

const treeFiles = async (root: string): Promise<readonly string[]> => {
  await realDirectory(root, root);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Unity project source cannot contain symlink or reparse entries.",
        );
      }
      if (metadata.isDirectory()) await visit(absolute);
      else if (metadata.isFile())
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      else {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Unity project source contains an unsupported filesystem entry.",
        );
      }
    }
  };
  await visit(root);
  return files;
};

const treeManifest = async (root: string): Promise<TreeManifest> => {
  const hash = createHash("sha256");
  let fileCount = 0;
  let logicalBytes = 0;
  for (const relative of await treeFiles(root)) {
    const content = await readFile(path.join(root, ...relative.split("/")));
    hash.update(relative);
    hash.update(Buffer.from([0]));
    hash.update(content);
    fileCount += 1;
    logicalBytes += content.byteLength;
  }
  return { digest: hash.digest("hex"), fileCount, logicalBytes };
};

const safeWorkspacePath = (workspaceRoot: string, workspaceId: string): string => {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, workspaceId);
  if (path.dirname(target) !== root) {
    throw new HoneyBeeCoreError(
      "workspace.invalid-project",
      "Workspace ID escaped the broker workspace root.",
    );
  }
  return target;
};

export class UnityProjectBootstrap {
  public async manifest(sourceProjectPath: string): Promise<SourceManifest> {
    await realDirectory(sourceProjectPath, "sourceProjectPath");
    const assets = await treeManifest(path.join(sourceProjectPath, "Assets"));
    const packages = await treeManifest(path.join(sourceProjectPath, "Packages"));
    const settings = await treeManifest(path.join(sourceProjectPath, "ProjectSettings"));
    return {
      schemaVersion: 1,
      digest: createHash("sha256")
        .update(assets.digest)
        .update(Buffer.from([0]))
        .update(packages.digest)
        .update(Buffer.from([0]))
        .update(settings.digest)
        .digest("hex"),
      assetsDigest: assets.digest,
      packagesDigest: packages.digest,
      projectSettingsDigest: settings.digest,
      fileCount: assets.fileCount + packages.fileCount + settings.fileCount,
      logicalBytes: assets.logicalBytes + packages.logicalBytes + settings.logicalBytes,
    };
  }

  public async prepare(
    sourceProjectPath: string,
    workspaceRoot: string,
    workspaceId: string,
  ): Promise<string> {
    await realDirectory(workspaceRoot, "workspaceStorage.workspaceRoot");
    const workspacePath = safeWorkspacePath(workspaceRoot, workspaceId);
    try {
      await lstat(workspacePath);
      throw new HoneyBeeCoreError(
        "workspace.already-exists",
        "Unity workspace shell already exists.",
      );
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await mkdir(workspacePath);
    try {
      for (const directory of SOURCE_DIRECTORIES) {
        const source = path.join(sourceProjectPath, directory);
        const destination = path.join(workspacePath, directory);
        await mkdir(destination);
        for (const relative of await treeFiles(source)) {
          const target = path.join(destination, ...relative.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(path.join(source, ...relative.split("/")), target);
        }
      }
      try {
        await lstat(path.join(workspacePath, "Library"));
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Prepared Unity workspace must not contain Library.",
        );
      } catch (error) {
        if (error instanceof HoneyBeeCoreError) throw error;
        if (errorCode(error) !== "ENOENT") throw error;
      }
      return workspacePath;
    } catch (error) {
      await rm(workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  public async cleanupUnacquired(workspaceRoot: string, workspaceId: string): Promise<void> {
    const workspacePath = safeWorkspacePath(workspaceRoot, workspaceId);
    for (const ownershipEntry of ["Library", ".testplay-vhdx-workspace-owner.json"]) {
      try {
        await lstat(path.join(workspacePath, ownershipEntry));
        throw new HoneyBeeCoreError(
          "workspace.cleanup-unsafe",
          "Refusing to remove a workspace shell that may be provider-owned.",
        );
      } catch (error) {
        if (error instanceof HoneyBeeCoreError) throw error;
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    await rm(workspacePath, { recursive: true, force: true });
  }

  public async verifyReleased(workspaceRoot: string, workspaceId: string): Promise<void> {
    const workspacePath = safeWorkspacePath(workspaceRoot, workspaceId);
    try {
      await lstat(workspacePath);
      throw new HoneyBeeCoreError(
        "workspace.residual-detected",
        "Workspace shell still exists after release.",
      );
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

export interface WorkspaceAcquireRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly consumerId: string;
  readonly workspaceId: string;
  readonly parentKey: UnityWorkspaceParentKey;
  readonly clientPid: number;
  readonly storeMaxAllocatedBytes?: number;
  readonly minimumHostFreeBytes?: number;
}

export interface WorkspaceLease {
  readonly leaseId: string;
  readonly runId: string;
  readonly parentKey: string;
  readonly mountPath: string;
  readonly state: string;
  readonly retained: boolean;
}

export interface WorkspaceAcquireReceipt {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly provider: string;
  readonly lease: WorkspaceLease;
  readonly [key: string]: unknown;
}

export interface WorkspaceReleaseReceipt {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly provider: string;
  readonly lease?: WorkspaceLease;
  readonly metrics: Readonly<{ cleanupState: string; [key: string]: unknown }>;
  readonly [key: string]: unknown;
}

const requiredString = (value: Record<string, unknown>, name: string): string => {
  const candidate = value[name];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Missing string field " + name + ".");
  }
  return candidate;
};

const leaseFrom = (value: unknown): WorkspaceLease => {
  if (!isRecord(value)) throw new Error("Workspace response has no lease.");
  return {
    leaseId: requiredString(value, "leaseId"),
    runId: requiredString(value, "runId"),
    parentKey: requiredString(value, "parentKey"),
    mountPath: requiredString(value, "mountPath"),
    state: requiredString(value, "state"),
    retained: value.retained === true,
  };
};

export class UnityWorkspaceStorageCliAdapter {
  #binaryVerification: Promise<void> | undefined;

  public constructor(
    private readonly command: AgentCommand,
    private readonly expectedProvider: string,
    private readonly expectedBinarySha256: string,
  ) {}

  public preflight(): Promise<void> {
    return this.verifyBinary();
  }

  public async acquire(
    request: WorkspaceAcquireRequest,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceAcquireReceipt> {
    await this.verifyBinary();
    let result: CommandResult;
    try {
      result = await runCommand(this.command, ["workspace", "acquire", "--request", "-"], {
        cwd: workspacePath,
        input: JSON.stringify(request),
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new HoneyBeeCoreError(
        "workspace.command-ambiguous",
        "Workspace acquire process failed before a response was confirmed.",
        undefined,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.termination !== "exited" || result.exitCode === null) {
      throw new HoneyBeeCoreError(
        "workspace.command-ambiguous",
        "Workspace acquire did not produce a definitive response.",
        undefined,
        {
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    let parsed: unknown;
    try {
      parsed = parseOneJson(result.stdout, "unity-workspace-storage acquire");
    } catch {
      throw new HoneyBeeCoreError(
        "workspace.command-ambiguous",
        "Workspace acquire response was not valid JSON.",
        undefined,
        {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    if (result.exitCode !== 0) {
      throw new HoneyBeeCoreError(
        "workspace.command-failed",
        "Workspace acquire was rejected.",
        undefined,
        {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    if (!isRecord(parsed)) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace acquire response must be an object.",
      );
    }
    let lease: WorkspaceLease;
    try {
      lease = leaseFrom(parsed.lease);
    } catch {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace acquire response has no valid lease.",
      );
    }
    const expectedMount = path.resolve(workspacePath, "Library");
    if (
      parsed.schemaVersion !== 1 ||
      parsed.requestId !== request.requestId ||
      parsed.provider !== this.expectedProvider ||
      lease.runId !== request.consumerId ||
      lease.parentKey !== request.parentKey.digest ||
      lease.state !== "ready" ||
      lease.retained ||
      path.resolve(lease.mountPath) !== expectedMount
    ) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace acquire response violated the public contract.",
      );
    }
    try {
      const mount = await lstat(expectedMount);
      if (!mount.isDirectory()) throw new Error("mount is not a directory");
    } catch {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace acquire did not publish the expected Library mount.",
      );
    }
    return {
      ...parsed,
      schemaVersion: 1,
      requestId: request.requestId,
      provider: this.expectedProvider,
      lease,
    };
  }

  public async release(
    leaseId: string,
    requestId: string,
    cwd: string,
  ): Promise<WorkspaceReleaseReceipt> {
    await this.verifyBinary();
    let result: CommandResult;
    try {
      result = await runCommand(
        this.command,
        ["workspace", "release", "--lease-id", leaseId, "--request-id", requestId],
        { cwd, timeoutMs: 120_000 },
      );
    } catch (error) {
      throw new HoneyBeeCoreError(
        "workspace.release-failed",
        "Workspace release process failed.",
        undefined,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.termination !== "exited" || result.exitCode !== 0) {
      throw new HoneyBeeCoreError(
        "workspace.release-failed",
        "Workspace release did not complete.",
        undefined,
        {
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    let parsed: unknown;
    try {
      parsed = parseOneJson(result.stdout, "unity-workspace-storage release");
    } catch {
      throw new HoneyBeeCoreError(
        "workspace.release-failed",
        "Workspace release response was not valid JSON.",
      );
    }
    if (!isRecord(parsed) || !isRecord(parsed.metrics)) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace release response violated the public contract.",
      );
    }
    if (
      parsed.schemaVersion !== 1 ||
      parsed.requestId !== requestId ||
      parsed.provider !== this.expectedProvider ||
      parsed.metrics.cleanupState !== "released"
    ) {
      throw new HoneyBeeCoreError(
        "workspace.release-failed",
        "Workspace cleanup was not confirmed as released.",
      );
    }
    return {
      ...parsed,
      schemaVersion: 1,
      requestId,
      provider: this.expectedProvider,
      metrics: parsed.metrics as WorkspaceReleaseReceipt["metrics"],
    };
  }

  public async status(requestId: string, cwd: string): Promise<Record<string, unknown>> {
    await this.verifyBinary();
    const result = await runCommand(
      this.command,
      ["workspace", "status", "--request-id", requestId],
      { cwd, timeoutMs: 30_000 },
    );
    if (result.termination !== "exited" || result.exitCode !== 0) {
      throw new HoneyBeeCoreError("workspace.command-failed", "Workspace status failed.");
    }
    const parsed = parseOneJson(result.stdout, "unity-workspace-storage status");
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.requestId !== requestId ||
      parsed.provider !== this.expectedProvider ||
      !isRecord(parsed.status)
    ) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace status response violated the public contract.",
      );
    }
    return parsed;
  }

  private verifyBinary(): Promise<void> {
    this.#binaryVerification ??= (async () => {
      if (!path.isAbsolute(this.command.command)) {
        throw new HoneyBeeCoreError(
          "workspace.protocol-invalid",
          "Workspace storage command must be an absolute pinned executable.",
        );
      }
      const bytes = await readFile(this.command.command);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== this.expectedBinarySha256) {
        throw new HoneyBeeCoreError(
          "workspace.protocol-invalid",
          "Workspace storage executable checksum does not match the pinned config.",
        );
      }
    })();
    return this.#binaryVerification;
  }
}

export interface TestPlayEvidenceFile {
  readonly name: string;
  readonly mediaType:
    "application/json" | "application/xml" | "application/x-ndjson" | "text/plain; charset=utf-8";
  readonly content: string;
  readonly digest: ContentDigest;
}

export interface TestPlayRunResult {
  readonly command: CommandResult;
  readonly response?: unknown;
  readonly artifactRoot?: string;
  readonly evidence: readonly TestPlayEvidenceFile[];
}

const evidenceMediaType = (name: string): TestPlayEvidenceFile["mediaType"] => {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".xml")) return "application/xml";
  if (name.endsWith(".ndjson")) return "application/x-ndjson";
  return "text/plain; charset=utf-8";
};

export class TestPlayCliAdapter {
  public constructor(private readonly config: UnityWorkConfigV1["testplay"]) {}

  public async run(
    runId: RunId,
    workspacePath: string,
    signal: AbortSignal,
    lifecycle: Required<CommandLifecycle>,
  ): Promise<TestPlayRunResult> {
    const configPath = path.join(workspacePath, ".honeybee-testplay-" + runId + ".json");
    await writeFile(
      configPath,
      JSON.stringify({
        schema_version: "1",
        unity_path: this.config.unityPath,
        project_path: workspacePath,
        test_platform: this.config.platform,
        timeout: { total_ms: this.config.timeoutMs },
        result_dir: ".testplay/results",
        retention: { max_runs: 0 },
        bridge: { enabled: false },
      }),
      "utf8",
    );
    const before = await this.runDirectories(workspacePath);
    const args = ["run", "--config", configPath, "--no-bridge"];
    if (this.config.filter !== undefined) args.push("--filter", this.config.filter);
    const command = await runCommand(this.config.command, args, {
      cwd: workspacePath,
      timeoutMs: this.config.timeoutMs + 10_000,
      signal,
      lifecycle,
      environment: { HONEYBEE_UNITY_PROJECT_PATH: workspacePath },
    });
    let response: unknown;
    try {
      response = parseOneJson(command.stdout, "testplay run");
    } catch {
      response = undefined;
    }
    const artifactRoot = await this.resolveArtifactRoot(workspacePath, before, response);
    const evidence = artifactRoot === undefined ? [] : await this.readEvidenceFiles(artifactRoot);
    return {
      command,
      ...(response === undefined ? {} : { response }),
      ...(artifactRoot === undefined ? {} : { artifactRoot }),
      evidence,
    };
  }

  public async recoverEvidence(workspacePath: string): Promise<readonly TestPlayEvidenceFile[]> {
    const runsRoot = path.join(workspacePath, ".testplay", "runs");
    let runs: readonly string[];
    try {
      runs = await readdir(runsRoot);
    } catch {
      return [];
    }
    if (runs.length !== 1 || runs[0] === undefined) return [];
    return this.readEvidenceFiles(path.join(runsRoot, runs[0]));
  }

  private async runDirectories(workspacePath: string): Promise<ReadonlySet<string>> {
    try {
      return new Set(await readdir(path.join(workspacePath, ".testplay", "runs")));
    } catch {
      return new Set();
    }
  }

  private async resolveArtifactRoot(
    workspacePath: string,
    before: ReadonlySet<string>,
    response: unknown,
  ): Promise<string | undefined> {
    const runsRoot = path.resolve(workspacePath, ".testplay", "runs");
    const responseRunId =
      isRecord(response) && typeof response.run_id === "string" ? response.run_id : undefined;
    if (responseRunId !== undefined && /^[A-Za-z0-9._-]+$/u.test(responseRunId)) {
      const candidate = path.resolve(runsRoot, responseRunId);
      if (path.dirname(candidate) === runsRoot) return candidate;
    }
    try {
      const created = (await readdir(runsRoot)).filter((name) => !before.has(name));
      if (created.length === 1) return path.resolve(runsRoot, created[0] as string);
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async readEvidenceFiles(root: string): Promise<readonly TestPlayEvidenceFile[]> {
    const names = [
      "results.xml",
      "summary.json",
      "manifest.json",
      "stdout.log",
      "stderr.log",
      "events.ndjson",
    ];
    const files: TestPlayEvidenceFile[] = [];
    for (const name of names) {
      try {
        const bytes = await readFile(path.join(root, name));
        files.push({
          name,
          mediaType: evidenceMediaType(name),
          content: bytes.toString("utf8"),
          digest: digestOf(bytes),
        });
      } catch {
        continue;
      }
    }
    return files;
  }
}
