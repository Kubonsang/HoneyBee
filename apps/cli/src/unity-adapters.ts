import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  ContentDigestSchema,
  HoneyBeeCoreError,
  trustedAgentInvocation,
  verifyAgentLaunchTrust,
  type AgentCommand,
  type AgentExitObservation,
  type AgentProcessResult,
  type AgentProcessRunner,
  type ContentDigest,
  type RunId,
  type StepId,
  type UnityWorkConfigV1,
  type UnityBridgeOverlay,
  type UnityCapability,
  type WarmBridgeBindingV1,
  type UnityWorkspaceParentKey,
} from "@honeybee/core";

import { physicalPathsOverlap, samePath } from "./path-safety.js";
import { terminateProcessTree } from "./process-control.js";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 32 * 1024 * 1024;
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

const createExclusiveFile = async (target: string, content: string): Promise<void> => {
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof HoneyBeeCoreError) throw error;
    if (errorCode(error) === "EEXIST") {
      throw new HoneyBeeCoreError(
        "workspace.cleanup-unsafe",
        "The reserved TestPlay config path already exists.",
      );
    }
    throw new HoneyBeeCoreError("testplay.failed", "The TestPlay config could not be created.");
  }
};

const removeStaleSourceAssetDatabaseLock = async (libraryPath: string): Promise<void> => {
  const lockPath = path.join(libraryPath, "SourceAssetDB-lock");
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new HoneyBeeCoreError(
      "workspace.protocol-invalid",
      "The acquired Library lock could not be inspected safely.",
    );
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    throw new HoneyBeeCoreError(
      "workspace.protocol-invalid",
      "The acquired Library lock is not a private regular file.",
    );
  }
  try {
    const handle = await open(lockPath, "r");
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== initial.dev ||
        opened.ino !== initial.ino
      ) {
        throw new HoneyBeeCoreError(
          "workspace.protocol-invalid",
          "The acquired Library lock changed while it was being opened.",
        );
      }
    } finally {
      await handle.close();
    }
    await rm(lockPath);
    await lstat(lockPath);
    throw new HoneyBeeCoreError(
      "workspace.protocol-invalid",
      "The acquired Library lock remained after removal.",
    );
  } catch (error) {
    if (error instanceof HoneyBeeCoreError) throw error;
    if (errorCode(error) === "ENOENT") return;
    throw new HoneyBeeCoreError(
      "workspace.protocol-invalid",
      "The acquired Library lock could not be removed safely.",
    );
  }
};

const readBoundedEvidenceFile = async (
  target: string,
  maxBytes: number,
): Promise<Buffer | undefined> => {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new HoneyBeeCoreError("testplay.failed", "TestPlay Evidence could not be inspected.");
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new HoneyBeeCoreError(
      "testplay.failed",
      "TestPlay Evidence must be a private regular file.",
    );
  }
  try {
    const handle = await open(target, "r");
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== entry.dev ||
        opened.ino !== entry.ino
      ) {
        throw new HoneyBeeCoreError(
          "testplay.failed",
          "TestPlay Evidence changed while it was being opened.",
        );
      }
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) {
        throw new HoneyBeeCoreError(
          "testplay.failed",
          "TestPlay Evidence exceeded its byte budget.",
        );
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof HoneyBeeCoreError) throw error;
    throw new HoneyBeeCoreError("testplay.failed", "TestPlay Evidence could not be read.");
  }
};

export interface CommandResult extends AgentExitObservation {
  readonly stdout: string;
  readonly stderr: string;
  readonly termination: "exited" | "timed-out" | "output-limit" | "cancelled";
}

export interface CommandLifecycle {
  readonly onStarted?: (
    pid: number,
    metadata?: Readonly<{ containment?: "deferred-v1" }>,
  ) => Promise<void>;
  readonly onRegistered?: (pid: number) => Promise<void>;
  readonly onExited?: (observation: AgentExitObservation) => Promise<void>;
}

const DEFERRED_PROCESS_LAUNCHER = String.raw`
const { spawn } = require("node:child_process");
let registered = false;
let activated = false;
let target;
let targetClosed = false;
let targetSpawnFailed = false;
let keepAlive;
let stdoutBytes = 0;
let stderrBytes = 0;
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const send = (message, callback) => {
  if (!process.connected) {
    if (callback) callback();
    return;
  }
  process.send(message, undefined, undefined, callback);
};
const finish = (code) => {
  process.exitCode = typeof code === "number" ? code : 1;
  if (keepAlive) clearInterval(keepAlive);
  if (process.connected) process.disconnect();
};
process.on("message", (message) => {
  if (message && message.type === "register" && !registered) {
    registered = true;
    send({ type: "registered" });
    return;
  }
  if (!message || message.type !== "start" || !registered || activated) return;
  activated = true;
  try {
    target = spawn(message.command, message.args, {
      cwd: process.cwd(),
      env: message.targetEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    send({ type: "target-error" });
    return;
  }
  target.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    process.stdout.write(chunk);
  });
  target.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    process.stderr.write(chunk);
  });
  target.once("error", () => {
    targetSpawnFailed = true;
    send({ type: "target-error" });
  });
  const inputFailed = () => {
    send({ type: "input-error" });
  };
  target.stdin.once("error", inputFailed);
  target.stdin.once("close", () => {
    if (!target.stdin.writableFinished && !targetClosed) inputFailed();
  });
  target.once("spawn", () => {
    const inputWritten = () => {
      send({ type: "input-written" });
    };
    if (message.input === undefined) target.stdin.end(inputWritten);
    else target.stdin.end(message.input, "utf8", inputWritten);
  });
  target.once("close", (exitCode, signal) => {
    targetClosed = true;
    if (!targetSpawnFailed) {
      send({ type: "target-exit", exitCode, signal, stdoutBytes, stderrBytes });
    }
  });
});
process.on("disconnect", () => {
  if (!registered) finish(0);
});
if (!process.connected) process.exit(0);
keepAlive = setInterval(() => {}, 1000);
`;

const isDeferredMessage = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && typeof value.type === "string";

const internalLauncherEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  const allowed =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

export const runCommand = (
  command: AgentCommand,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    input?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    lifecycle?: CommandLifecycle;
    environment?: Readonly<Record<string, string>>;
    terminateTree?: boolean;
    deferExecutionUntilStarted?: boolean;
    maxOutputBytes?: number;
  }>,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const targetArgs = [...(command.args ?? []), ...args];
    const deferred = options.deferExecutionUntilStarted === true;
    const targetEnvironment = { ...process.env, ...command.env, ...options.environment };
    const child = spawn(
      deferred ? process.execPath : command.command,
      deferred ? ["-e", DEFERRED_PROCESS_LAUNCHER] : targetArgs,
      {
        cwd: options.cwd,
        env: deferred ? internalLauncherEnvironment() : targetEnvironment,
        shell: false,
        stdio: deferred ? ["ignore", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: options.terminateTree === true && process.platform !== "win32",
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let termination: CommandResult["termination"] = "exited";
    let startBarrier: Promise<void> = Promise.resolve();
    let treeTermination: Promise<void> | undefined;
    let forcedTermination: ReturnType<typeof setTimeout> | undefined;
    let targetExit: Pick<AgentExitObservation, "exitCode" | "signal"> | undefined;
    let activationResolve: (() => void) | undefined;
    let activationReject: ((error: unknown) => void) | undefined;
    let registrationResolve: (() => void) | undefined;
    let registrationReject: ((error: unknown) => void) | undefined;
    let registrationDurable = !deferred;
    let persistedObservation: AgentExitObservation | undefined;
    let exitPersistence: Promise<void> | undefined;
    let outputProgress = (): void => undefined;
    let outputWaitReject: ((error: unknown) => void) | undefined;

    const observation = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): AgentExitObservation => ({
      pid: child.pid ?? -1,
      exitCode,
      signal,
      durationMs: Date.now() - startedAt,
      stdoutBytes,
      stderrBytes,
      stdoutDigest: ContentDigestSchema.parse("sha256:" + stdoutHash.digest("hex")),
      stderrDigest: ContentDigestSchema.parse("sha256:" + stderrHash.digest("hex")),
    });
    const waitForObservedOutput = (
      expectedStdoutBytes: number,
      expectedStderrBytes: number,
    ): Promise<void> =>
      new Promise((waitResolve, waitReject) => {
        outputWaitReject = waitReject;
        outputProgress = () => {
          if (stdoutBytes > expectedStdoutBytes || stderrBytes > expectedStderrBytes) {
            waitReject(new Error("Deferred process output framing was inconsistent."));
          } else if (stdoutBytes === expectedStdoutBytes && stderrBytes === expectedStderrBytes) {
            outputWaitReject = undefined;
            outputProgress = () => undefined;
            waitResolve();
          }
        };
        outputProgress();
      });
    if (deferred) {
      child.on("message", (message: unknown) => {
        if (!isDeferredMessage(message)) return;
        if (message.type === "registered") {
          const resolveRegistration = registrationResolve;
          const rejectRegistration = registrationReject;
          registrationResolve = undefined;
          registrationReject = undefined;
          const pid = child.pid;
          if (pid === undefined) {
            rejectRegistration?.(new Error("The deferred containment process has no PID."));
            return;
          }
          void Promise.resolve()
            .then(() => options.lifecycle?.onRegistered?.(pid))
            .then(
              () => {
                registrationDurable = true;
                resolveRegistration?.();
              },
              (error: unknown) => rejectRegistration?.(error),
            );
        } else if (message.type === "input-written") {
          activationResolve?.();
          activationResolve = undefined;
          activationReject = undefined;
        } else if (message.type === "input-error") {
          activationReject?.(
            new HoneyBeeCoreError(
              "agent.input-write-failed",
              "Failed to deliver input to the deferred process.",
            ),
          );
          activationResolve = undefined;
          activationReject = undefined;
        } else if (message.type === "target-error") {
          activationReject?.(new Error("The deferred target process could not be started."));
          activationResolve = undefined;
          activationReject = undefined;
        } else if (message.type === "target-exit") {
          targetExit = {
            exitCode: typeof message.exitCode === "number" ? message.exitCode : null,
            signal: typeof message.signal === "string" ? (message.signal as NodeJS.Signals) : null,
          };
          const expectedStdoutBytes = message.stdoutBytes;
          const expectedStderrBytes = message.stderrBytes;
          if (
            !Number.isSafeInteger(expectedStdoutBytes) ||
            (expectedStdoutBytes as number) < 0 ||
            !Number.isSafeInteger(expectedStderrBytes) ||
            (expectedStderrBytes as number) < 0
          ) {
            exitPersistence = Promise.reject(
              new Error("The deferred process returned invalid output counters."),
            );
          } else {
            exitPersistence = (async () => {
              await waitForObservedOutput(
                expectedStdoutBytes as number,
                expectedStderrBytes as number,
              );
              persistedObservation = observation(
                targetExit?.exitCode ?? null,
                targetExit?.signal ?? null,
              );
              await options.lifecycle?.onExited?.(persistedObservation);
              const pid = child.pid;
              if (pid === undefined) {
                throw new Error("The deferred containment process has no PID.");
              }
              treeTermination ??= terminateProcessTree(pid);
              await treeTermination;
            })();
          }
          void exitPersistence.catch(() => terminate("cancelled"));
        }
      });
    }

    const terminate = (reason: CommandResult["termination"]): void => {
      if (termination === "exited") termination = reason;
      if (child.exitCode === null && child.signalCode === null) {
        if (options.terminateTree === true) {
          const pid = child.pid;
          if (pid !== undefined && treeTermination === undefined) {
            treeTermination = terminateProcessTree(pid);
            void treeTermination.catch((error: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              options.signal?.removeEventListener("abort", onAbort);
              reject(error);
            });
          }
          return;
        }
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
      if (stdoutBytes + stderrBytes > (options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES)) {
        terminate("output-limit");
        return;
      }
      target.push(bytes);
      outputProgress();
    };
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdout, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(stderr, "stderr", chunk));

    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) return;
      startBarrier = (
        options.lifecycle?.onStarted?.(
          pid,
          deferred ? { containment: "deferred-v1" } : undefined,
        ) ?? Promise.resolve()
      )
        .then(
          () =>
            new Promise<void>((registerResolve, registerReject) => {
              if (!deferred) {
                registerResolve();
                return;
              }
              if (child.exitCode !== null || child.signalCode !== null) {
                registerResolve();
                return;
              }
              if (termination !== "exited") {
                registerResolve();
                return;
              }
              registrationResolve = registerResolve;
              registrationReject = registerReject;
              child.send?.({ type: "register" }, (error) => {
                if (error !== null) registerReject(error);
              });
            }),
        )
        .then(
          () =>
            new Promise<void>((writeResolve, writeReject) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                writeResolve();
                return;
              }
              if (termination !== "exited") {
                writeResolve();
                return;
              }
              if (deferred) {
                activationResolve = writeResolve;
                activationReject = writeReject;
                child.send?.(
                  {
                    type: "start",
                    command: command.command,
                    args: targetArgs,
                    targetEnvironment,
                    ...(options.input === undefined ? {} : { input: options.input }),
                  },
                  (error) => {
                    if (error !== null) writeReject(error);
                  },
                );
                return;
              }
              const stdin = child.stdin;
              if (stdin === null) {
                writeReject(new Error("The process stdin pipe is unavailable."));
                return;
              }
              if (options.input === undefined) {
                stdin.end(writeResolve);
                return;
              }
              stdin.once("error", writeReject);
              stdin.end(options.input, "utf8", writeResolve);
            }),
        );
      if (termination !== "exited" && options.terminateTree === true) terminate(termination);
      void startBarrier.catch(() => terminate("cancelled"));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
      options.signal?.removeEventListener("abort", onAbort);
      registrationReject?.(error);
      activationReject?.(error);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
      options.signal?.removeEventListener("abort", onAbort);
      registrationReject?.(new Error("The deferred process exited before registration completed."));
      outputWaitReject?.(new Error("The deferred process closed before output was drained."));
      activationReject?.(new Error("The deferred process exited before accepting its input."));
      void (async () => {
        try {
          const [startResult, treeResult] = await Promise.allSettled([
            startBarrier,
            treeTermination ?? Promise.resolve(),
          ]);
          if (treeResult.status === "rejected") throw treeResult.reason;
          if (startResult.status === "rejected") throw startResult.reason;
          if (exitPersistence !== undefined) await exitPersistence;
          const finalObservation =
            persistedObservation ??
            observation(targetExit?.exitCode ?? exitCode, targetExit?.signal ?? signal);
          if (persistedObservation === undefined && registrationDurable) {
            await options.lifecycle?.onExited?.(finalObservation);
          }
          resolve({
            ...finalObservation,
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

export class UnityAgentProcessRunner implements AgentProcessRunner {
  public async run(
    request: Parameters<AgentProcessRunner["run"]>[0],
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    if (request.adapter !== undefined && request.adapter !== "stdio-framed-v2") {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Structured Agent sessions are available only through the Desktop runtime.",
        request.stepId,
      );
    }
    if (request.command.command.trim().length === 0) {
      throw new HoneyBeeCoreError(
        "validation.invalid-command",
        `The ${request.stepId} command cannot be empty.`,
        request.stepId,
      );
    }
    if (request.trust === undefined) {
      throw new HoneyBeeCoreError(
        "agent.trust-required",
        "Unity Agent execution requires an approved launch trust receipt.",
      );
    }
    await verifyAgentLaunchTrust(request.command, request.trust);
    const invocation = await trustedAgentInvocation(request.command, request.trust);
    let result: CommandResult;
    try {
      result = await runCommand(invocation, [], {
        cwd: invocation.cwd ?? process.cwd(),
        input: request.prompt,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        lifecycle,
        environment: {
          HONEYBEE_RUN_ID: request.runId,
          HONEYBEE_STEP_ID: request.stepId,
        },
        terminateTree: true,
        deferExecutionUntilStarted: true,
      });
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError(
        "agent.spawn-failed",
        `Failed to start the ${request.stepId} agent process.`,
        request.stepId,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    return {
      ...result,
      stepId: request.stepId,
      command: request.command.command,
    };
  }
}

export interface SourceManifest {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly assetsDigest: string;
  readonly packagesDigest: string;
  readonly projectSettingsDigest: string;
  readonly fileCount: number;
  readonly logicalBytes: number;
}

export interface MaterializedAgentContextFile {
  readonly logicalPath: string;
  readonly content: string;
  readonly contentDigest: ContentDigest;
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

const treeFiles = async (
  root: string,
  ignoredPaths: ReadonlySet<string> = new Set(),
): Promise<readonly string[]> => {
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
      else if (metadata.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (!ignoredPaths.has(relative)) files.push(relative);
      } else {
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

const treeManifest = async (
  root: string,
  ignoredPaths: ReadonlySet<string> = new Set(),
): Promise<TreeManifest> => {
  const hash = createHash("sha256");
  hash.update("honeybee-tree-manifest-v1\0", "utf8");
  let fileCount = 0;
  let logicalBytes = 0;
  for (const relative of await treeFiles(root, ignoredPaths)) {
    const content = await readFile(path.join(root, ...relative.split("/")));
    const relativeBytes = Buffer.from(relative, "utf8");
    const relativeLength = Buffer.allocUnsafe(8);
    relativeLength.writeBigUInt64BE(BigInt(relativeBytes.byteLength));
    const contentLength = Buffer.allocUnsafe(8);
    contentLength.writeBigUInt64BE(BigInt(content.byteLength));
    hash.update(relativeLength);
    hash.update(relativeBytes);
    hash.update(contentLength);
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
  public async materializeAgentContext(
    sourceProjectPath: string,
    workspacePath: string,
  ): Promise<readonly MaterializedAgentContextFile[]> {
    const candidates: string[] = [];
    const agentsPath = path.join(sourceProjectPath, "AGENTS.md");
    try {
      const entry = await lstat(agentsPath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "AGENTS.md must be a private regular file.",
        );
      }
      candidates.push("AGENTS.md");
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const skillsRoot = path.join(sourceProjectPath, ".agents", "skills");
    try {
      const entry = await lstat(skillsRoot);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "The workspace Skill root must be a real directory.",
        );
      }
      for (const relative of await treeFiles(skillsRoot)) {
        if (relative.split("/").includes("..")) {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Agent context escaped its materialization root.",
          );
        }
        candidates.push(".agents/skills/" + relative);
      }
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (candidates.length > 512) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "Agent context exceeded its file-count budget.",
      );
    }
    const materialized: MaterializedAgentContextFile[] = [];
    let totalBytes = 0;
    for (const logicalPath of candidates.sort((left, right) => left.localeCompare(right))) {
      const source = path.join(sourceProjectPath, ...logicalPath.split("/"));
      const before = await lstat(source);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > 1024 * 1024
      ) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Agent context files must be private and at most 1 MiB.",
        );
      }
      const handle = await open(source, "r");
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino
        ) {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Agent context changed while it was being read.",
          );
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > 8 * 1024 * 1024) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Agent context exceeded its total byte budget.",
        );
      }
      const target = path.join(workspacePath, ...logicalPath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      const targetHandle = await open(target, "wx", 0o600);
      try {
        await targetHandle.writeFile(bytes);
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      materialized.push({
        logicalPath,
        content: bytes.toString("utf8"),
        contentDigest: digestOf(bytes),
      });
    }
    return materialized;
  }

  public async manifest(
    sourceProjectPath: string,
    ignoredPaths: ReadonlySet<string> = new Set(),
  ): Promise<SourceManifest> {
    await realDirectory(sourceProjectPath, "sourceProjectPath");
    const under = (prefix: string): ReadonlySet<string> =>
      new Set(
        [...ignoredPaths]
          .filter((relative) => relative.startsWith(prefix + "/"))
          .map((relative) => relative.slice(prefix.length + 1)),
      );
    const assets = await treeManifest(path.join(sourceProjectPath, "Assets"), under("Assets"));
    const packages = await treeManifest(
      path.join(sourceProjectPath, "Packages"),
      under("Packages"),
    );
    const settings = await treeManifest(
      path.join(sourceProjectPath, "ProjectSettings"),
      under("ProjectSettings"),
    );
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
    bridgeOverlay?: UnityBridgeOverlay,
  ): Promise<string> {
    await realDirectory(workspaceRoot, "workspaceStorage.workspaceRoot");
    if (await physicalPathsOverlap(sourceProjectPath, workspaceRoot)) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "Unity source and workspace roots must be physically disjoint.",
      );
    }
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
      if (bridgeOverlay !== undefined) {
        await this.installBridgeOverlay(workspacePath, bridgeOverlay);
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

  public async bridgeOverlayPaths(overlay: UnityBridgeOverlay): Promise<ReadonlySet<string>> {
    const sourcePath = path.resolve(overlay.sourcePath);
    const manifest = await treeManifest(sourcePath);
    if (manifest.digest !== overlay.digest) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "The TestPlay Bridge overlay digest does not match the managed profile.",
      );
    }
    const files = await treeFiles(sourcePath);
    if (!files.includes("package.json")) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "The TestPlay Bridge overlay has no package.json.",
      );
    }
    return new Set(files.map((relative) => `Packages/${overlay.packageName}/${relative}`));
  }

  public async verifyBridgeOverlay(
    projectRoot: string,
    overlay: UnityBridgeOverlay,
  ): Promise<void> {
    const target = path.join(projectRoot, "Packages", overlay.packageName);
    const manifest = await treeManifest(target);
    if (manifest.digest !== overlay.digest) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "The workspace-only TestPlay Bridge overlay changed during execution.",
      );
    }
  }

  private async installBridgeOverlay(
    projectRoot: string,
    overlay: UnityBridgeOverlay,
  ): Promise<void> {
    await this.bridgeOverlayPaths(overlay);
    const source = path.resolve(overlay.sourcePath);
    const destination = path.join(projectRoot, "Packages", overlay.packageName);
    try {
      await lstat(destination);
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "The source project already contains the reserved TestPlay Bridge package.",
      );
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await mkdir(destination);
    for (const relative of await treeFiles(source)) {
      const target = path.join(destination, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, ...relative.split("/")), target);
    }
    await this.verifyBridgeOverlay(projectRoot, overlay);
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

export interface WorkspaceAcquireRequestV2 {
  readonly schemaVersion: 2;
  readonly operation: "workspace-acquire";
  readonly requestId: string;
  readonly consumerId: string;
  readonly workspaceId: string;
  readonly parentId: string;
  readonly clientPid: number;
  readonly limits?: Readonly<{
    storeMaxAllocatedBytes?: number;
    minimumHostFreeBytes?: number;
  }>;
}

export type AnyWorkspaceAcquireRequest = WorkspaceAcquireRequest | WorkspaceAcquireRequestV2;

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
  private readonly execute: typeof runCommand;
  private readonly protocolVersion: 1 | 2;

  public constructor(
    private readonly command: AgentCommand,
    private readonly expectedProvider: string,
    private readonly expectedBinarySha256: string,
    executeOrProtocol: typeof runCommand | 1 | 2 = runCommand,
    protocolVersion: 1 | 2 = 1,
  ) {
    this.execute = typeof executeOrProtocol === "function" ? executeOrProtocol : runCommand;
    this.protocolVersion =
      typeof executeOrProtocol === "number" ? executeOrProtocol : protocolVersion;
  }

  public preflight(): Promise<void> {
    return this.verifyBinary();
  }

  public async acquire(
    request: AnyWorkspaceAcquireRequest,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceAcquireReceipt> {
    await this.verifyBinary();
    let result: CommandResult;
    try {
      result = await this.execute(this.command, ["workspace", "acquire", "--request", "-"], {
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
      if (request.schemaVersion === 1) {
        lease = leaseFrom(parsed.lease);
      } else {
        if (!isRecord(parsed.lease)) throw new Error("Workspace response has no lease.");
        if (
          requiredString(parsed.lease, "workspaceId") !== request.workspaceId ||
          !samePath(requiredString(parsed.lease, "workspacePath"), workspacePath)
        ) {
          throw new Error("Workspace response identity does not match the schema-2 request.");
        }
        lease = {
          leaseId: requiredString(parsed.lease, "leaseId"),
          runId: requiredString(parsed.lease, "consumerId"),
          parentKey: requiredString(parsed.lease, "parentId"),
          mountPath: requiredString(parsed.lease, "mountPath"),
          state: requiredString(parsed.lease, "state"),
          retained: false,
        };
      }
    } catch {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace acquire response has no valid lease.",
      );
    }
    const expectedMount = path.resolve(workspacePath, "Library");
    const expectedParent =
      request.schemaVersion === 1 ? request.parentKey.digest : request.parentId;
    const schemaValid =
      request.schemaVersion === 1
        ? parsed.schemaVersion === 1
        : parsed.schemaVersion === 2 && parsed.ok === true;
    if (
      !schemaValid ||
      parsed.requestId !== request.requestId ||
      parsed.provider !== this.expectedProvider ||
      lease.runId !== request.consumerId ||
      lease.parentKey !== expectedParent ||
      lease.state !== "ready" ||
      lease.retained ||
      !samePath(lease.mountPath, expectedMount)
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
    // Unity may leave SourceAssetDB-lock in the immutable seed after a clean
    // batchmode parent build. It is process-lifetime state, not reusable
    // Library content. Remove only the exact verified child mount's private
    // lock before any HoneyBee-owned agent or Editor can start.
    await removeStaleSourceAssetDatabaseLock(expectedMount);
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
      result = await this.execute(
        this.command,
        [
          "workspace",
          "release",
          ...(this.protocolVersion === 2 ? ["--schema", "2"] : []),
          "--lease-id",
          leaseId,
          "--request-id",
          requestId,
        ],
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
    if (!isRecord(parsed)) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace release response violated the public contract.",
      );
    }
    const metrics = isRecord(parsed.metrics) ? parsed.metrics : undefined;
    if (
      (this.protocolVersion === 1 && metrics === undefined) ||
      (this.protocolVersion === 2 && parsed.metrics !== undefined && metrics === undefined)
    ) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace release response violated the public contract.",
      );
    }
    if (
      parsed.schemaVersion !== this.protocolVersion ||
      parsed.requestId !== requestId ||
      parsed.provider !== this.expectedProvider ||
      (this.protocolVersion === 1 && metrics?.cleanupState !== "released") ||
      (this.protocolVersion === 2 && parsed.ok !== true)
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
      metrics:
        this.protocolVersion === 2
          ? { ...metrics, cleanupState: "released" }
          : (metrics as WorkspaceReleaseReceipt["metrics"]),
    };
  }

  public async status(requestId: string, cwd: string): Promise<Record<string, unknown>> {
    await this.verifyBinary();
    const result = await this.execute(
      this.command,
      [
        "workspace",
        "status",
        ...(this.protocolVersion === 2 ? ["--schema", "2"] : []),
        "--request-id",
        requestId,
      ],
      { cwd, timeoutMs: 30_000 },
    );
    if (result.termination !== "exited" || result.exitCode !== 0) {
      throw new HoneyBeeCoreError("workspace.command-failed", "Workspace status failed.");
    }
    const parsed = parseOneJson(result.stdout, "unity-workspace-storage status");
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== this.protocolVersion ||
      parsed.requestId !== requestId ||
      parsed.provider !== this.expectedProvider ||
      !isRecord(parsed.status) ||
      (this.protocolVersion === 2 && parsed.ok !== true)
    ) {
      throw new HoneyBeeCoreError(
        "workspace.protocol-invalid",
        "Workspace status response violated the public contract.",
      );
    }
    return parsed;
  }

  private verifyBinary(): Promise<void> {
    return (async () => {
      if ((this.command.args?.length ?? 0) > 0 || this.command.env !== undefined) {
        throw new HoneyBeeCoreError(
          "workspace.protocol-invalid",
          "Workspace storage must be one pinned executable without arguments or environment injection.",
        );
      }
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

const TestPlayCapabilityResponseSchema = z
  .object({
    schema_version: z.literal("1"),
    capability: z.enum(["compile", "warm-test"]),
    run_id: z.string().regex(/^[A-Za-z0-9._-]+$/u),
    artifact_root: z.string().min(1),
    exit_code: z.number().int(),
    backend: z.literal("bridge"),
    bridge: z
      .object({
        protocol_version: z.literal(3),
        workspace_id: z.string().min(1),
        editor_pid: z.number().int().positive(),
        bridge_session_id: z.string().min(1),
      })
      .strict(),
    compile_errors: z.number().int().nonnegative(),
    compile_error_details: z.array(z.unknown()).optional(),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    fallback_used: z.literal(false),
    cleanup_state: z.literal("released"),
    error: z.string().optional(),
  })
  .strict();

export type TestPlayCapabilityResponse = z.infer<typeof TestPlayCapabilityResponseSchema>;

export interface UnityCapabilityRunResult extends TestPlayRunResult {
  readonly capability: UnityCapability;
  readonly response?: TestPlayCapabilityResponse;
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
    lifecycle: CommandLifecycle & Required<Pick<CommandLifecycle, "onStarted" | "onExited">>,
  ): Promise<TestPlayRunResult> {
    const configPath = path.join(workspacePath, ".honeybee-testplay-" + runId + ".json");
    await createExclusiveFile(
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
      terminateTree: true,
      deferExecutionUntilStarted: true,
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

  public async runCapability(
    runId: RunId,
    capability: UnityCapability,
    binding: WarmBridgeBindingV1,
    workspacePath: string,
    timeoutMs: number,
    signal: AbortSignal,
    lifecycle: CommandLifecycle & Required<Pick<CommandLifecycle, "onStarted" | "onExited">>,
  ): Promise<UnityCapabilityRunResult> {
    const configPath = path.join(
      workspacePath,
      `.honeybee-capability-${runId}-${capability.id}.json`,
    );
    await createExclusiveFile(
      configPath,
      JSON.stringify({
        schema_version: "1",
        unity_path: this.config.unityPath,
        project_path: workspacePath,
        test_platform: "edit_mode",
        timeout: { total_ms: timeoutMs },
        result_dir: ".testplay/results",
        retention: { max_runs: 0 },
        bridge: { enabled: true },
      }),
    );
    const before = await this.runDirectories(workspacePath);
    const args = [
      "capability",
      capability.kind,
      "--config",
      configPath,
      "--require-bridge-session",
      binding.bridgeSessionId,
      "--require-editor-pid",
      String(binding.editorPid),
      "--workspace-id",
      binding.workspaceId,
      "--no-fallback",
    ];
    if (capability.kind === "warm-test") {
      if (capability.filter !== undefined) args.push("--filter", capability.filter);
      if (capability.category !== undefined) args.push("--category", capability.category);
    }
    const command = await runCommand(this.config.command, args, {
      cwd: workspacePath,
      timeoutMs: timeoutMs + 10_000,
      signal,
      lifecycle,
      environment: {
        HONEYBEE_UNITY_PROJECT_PATH: workspacePath,
        HONEYBEE_WORKSPACE_ID: binding.workspaceId,
        HONEYBEE_EDITOR_PID: String(binding.editorPid),
        HONEYBEE_BRIDGE_SESSION_ID: binding.bridgeSessionId,
      },
      terminateTree: true,
      deferExecutionUntilStarted: true,
    });
    let response: TestPlayCapabilityResponse | undefined;
    if (command.termination === "exited" && command.exitCode !== null) {
      let value: unknown;
      try {
        value = parseOneJson(command.stdout, `testplay capability ${capability.kind}`);
      } catch {
        throw new HoneyBeeCoreError(
          "capability.failed",
          "TestPlay capability stdout was not one JSON response.",
          capability.id,
        );
      }
      const parsed = TestPlayCapabilityResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new HoneyBeeCoreError(
          "capability.failed",
          "TestPlay capability response violated protocol v3.",
          capability.id,
        );
      }
      response = parsed.data;
      const expectedArtifactRoot = path.resolve(
        workspacePath,
        ".testplay",
        "runs",
        response.run_id,
      );
      const countsAreConsistent =
        response.total === response.passed + response.failed + response.skipped;
      const successfulCompile =
        capability.kind !== "compile" ||
        command.exitCode !== 0 ||
        (response.compile_errors === 0 && response.total === 0);
      const successfulWarmTest =
        capability.kind !== "warm-test" ||
        command.exitCode !== 0 ||
        (response.compile_errors === 0 &&
          response.total > 0 &&
          response.failed === 0 &&
          countsAreConsistent);
      if (
        response.capability !== capability.kind ||
        response.exit_code !== command.exitCode ||
        response.bridge.workspace_id !== binding.workspaceId ||
        response.bridge.editor_pid !== binding.editorPid ||
        response.bridge.bridge_session_id !== binding.bridgeSessionId ||
        !path.isAbsolute(response.artifact_root) ||
        !samePath(response.artifact_root, expectedArtifactRoot) ||
        (command.exitCode === 0 && !countsAreConsistent) ||
        !successfulCompile ||
        !successfulWarmTest ||
        (command.exitCode === 0 && response.error !== undefined && response.error.length > 0)
      ) {
        throw new HoneyBeeCoreError(
          "capability.failed",
          "TestPlay capability response did not match the requested execution.",
          capability.id,
        );
      }
    }
    const artifactRoot = await this.resolveArtifactRoot(workspacePath, before, response);
    const evidence = artifactRoot === undefined ? [] : await this.readEvidenceFiles(artifactRoot);
    if (response !== undefined) this.validateCapabilityEvidence(response, evidence, capability.id);
    return {
      capability,
      command,
      ...(response === undefined ? {} : { response }),
      ...(artifactRoot === undefined ? {} : { artifactRoot }),
      evidence,
    };
  }

  private validateCapabilityEvidence(
    response: TestPlayCapabilityResponse,
    evidence: readonly TestPlayEvidenceFile[],
    capabilityId: StepId,
  ): void {
    const summary = evidence.find((file) => file.name === "summary.json");
    const manifest = evidence.find((file) => file.name === "manifest.json");
    if (summary === undefined || manifest === undefined) {
      throw new HoneyBeeCoreError(
        "capability.failed",
        "TestPlay capability omitted its durable summary or manifest.",
        capabilityId,
      );
    }
    let summaryValue: unknown;
    let manifestValue: unknown;
    try {
      summaryValue = JSON.parse(summary.content) as unknown;
      manifestValue = JSON.parse(manifest.content) as unknown;
    } catch {
      throw new HoneyBeeCoreError(
        "capability.failed",
        "TestPlay capability Evidence was not valid JSON.",
        capabilityId,
      );
    }
    const parsedSummary = TestPlayCapabilityResponseSchema.safeParse(summaryValue);
    if (!parsedSummary.success || !isDeepStrictEqual(parsedSummary.data, response)) {
      throw new HoneyBeeCoreError(
        "capability.failed",
        "TestPlay capability summary did not match stdout.",
        capabilityId,
      );
    }
    if (
      !isRecord(manifestValue) ||
      manifestValue.schema_version !== "1" ||
      manifestValue.run_id !== response.run_id ||
      manifestValue.artifact_root !== response.artifact_root
    ) {
      throw new HoneyBeeCoreError(
        "capability.failed",
        "TestPlay capability manifest did not match stdout.",
        capabilityId,
      );
    }
    if (
      response.capability === "warm-test" &&
      evidence.every((file) => file.name !== "results.xml")
    ) {
      throw new HoneyBeeCoreError(
        "capability.failed",
        "Warm Test omitted its durable results.xml.",
        capabilityId,
      );
    }
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
    let totalBytes = 0;
    for (const name of names) {
      const remaining = MAX_EVIDENCE_TOTAL_BYTES - totalBytes;
      const bytes = await readBoundedEvidenceFile(
        path.join(root, name),
        Math.min(MAX_EVIDENCE_FILE_BYTES, remaining),
      );
      if (bytes === undefined) continue;
      totalBytes += bytes.byteLength;
      files.push({
        name,
        mediaType: evidenceMediaType(name),
        content: bytes.toString("utf8"),
        digest: digestOf(bytes),
      });
    }
    return files;
  }
}
