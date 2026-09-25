import { parseStorageServiceEvidence } from "./workspace-service-evidence.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";

import { storageToolPair } from "./workspace-tool-resolution.js";

import {
  WorkspaceCoreError,
  type StorageDiagnosticV1,
  type StorageCommand,
  type StorageLease,
  type StorageParentBuild,
  type StorageRemovalPreparation,
  type WorkspaceStoragePort,
} from "./workspace-types.js";

const COMMAND_TIMEOUT_MS = 120_000;
const COMMIT_POLL_MS = 5_000;
const COMMIT_QUERY_MS = 10_000;
const COMMIT_HEARTBEAT_MS = 30_000;
const COMMIT_IDLE_MS = 120_000;
const COMMIT_IDLE_ENV = "HONEYBEE_PARENT_COMMIT_IDLE_TIMEOUT_MS";
// Only these broker responses establish that finalization has returned and
// this transaction can be aborted. Transport/CLI errors do not establish that.
const COMPLETED_COMMIT_FAILURES = new Set([
  "parent-verification-failed",
  "storage-capacity-unavailable",
  "parent-commit-failed",
]);
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

type JsonObject = Record<string, unknown>;

class StorageResponseError extends WorkspaceCoreError {}

const object = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceCoreError(
      "storage.invalid-response",
      `${label} returned an invalid object.`,
    );
  }
  return value as JsonObject;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceCoreError("storage.invalid-response", `${label} is missing.`);
  }
  return value;
};

const parseResponse = (stdout: string, label: string): JsonObject => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new WorkspaceCoreError("storage.invalid-response", `${label} returned invalid JSON.`, {
      cause: error,
    });
  }
  const response = object(value, label);
  if (response.ok !== true && response.ok !== false) {
    throw new WorkspaceCoreError("storage.invalid-response", `${label} is missing ok.`);
  }
  if (response.ok !== true) {
    const body =
      typeof response.error === "object" && response.error !== null
        ? object(response.error, "error")
        : {};
    const upstreamCode = typeof body.code === "string" ? body.code : undefined;
    const capacityUnavailable = upstreamCode === "storage-capacity-unavailable";
    const mountIdentityMismatch =
      upstreamCode === "retained-mount-identity-mismatch" ||
      (upstreamCode === "retained-attach-failed" &&
        typeof body.message === "string" &&
        body.message.includes("validate-stale-mount-target:"));
    throw new StorageResponseError(
      upstreamCode === "retained-not-found"
        ? "storage.retained-not-found"
        : mountIdentityMismatch
          ? "storage.mount-identity-mismatch"
          : upstreamCode === "retained-in-use"
            ? "workspace.in-use"
            : "storage.operation-failed",
      capacityUnavailable
        ? "Workspace storage cannot reserve enough disk space for this operation."
        : typeof body.message === "string"
          ? body.message
          : `${label} failed.`,
      upstreamCode === undefined
        ? undefined
        : {
            upstreamCode,
            ...(capacityUnavailable
              ? {
                  remediation: [
                    "Remove unused Workspaces or free disk space, then retry.",
                    "A failed cache prepare keeps the previously registered cache unchanged.",
                  ],
                }
              : {}),
          },
    );
  }
  return response;
};

const run = (
  command: StorageCommand,
  args: readonly string[],
  input?: string,
  timeoutMs: number | null = COMMAND_TIMEOUT_MS,
  options: { control?: boolean; signal?: AbortSignal } = {},
): Promise<JsonObject> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    try {
      const child = execFile(
        options.control === true
          ? storageToolPair(command).controlCommand
          : storageToolPair(command).clientCommand,
        [...args],
        {
          encoding: "utf8",
          signal: controller.signal,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          cleanup();
          if (timedOut) {
            reject(
              new WorkspaceCoreError(
                "storage.command-timeout",
                `${args.slice(0, 2).join(" ")} exceeded ${timeoutMs}ms.`,
                { cause: error },
              ),
            );
            return;
          }
          if (error !== null) {
            if (stdout.trim().length > 0) {
              try {
                parseResponse(stdout, args.join(" "));
              } catch (responseError) {
                if (responseError instanceof WorkspaceCoreError) {
                  reject(responseError);
                  return;
                }
              }
            }
            reject(
              new WorkspaceCoreError(
                (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? "storage.command-not-found"
                  : (error as NodeJS.ErrnoException).syscall?.startsWith("spawn") === true
                    ? "storage.command-start-failed"
                    : "storage.operation-failed",
                stderr.trim().length > 0 ? stderr.trim() : error.message,
                { cause: error },
              ),
            );
            return;
          }
          try {
            resolve(parseResponse(stdout, args.join(" ")));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
      if (input !== undefined) {
        child.stdin?.on?.("error", (error: Error) => {
          cleanup();
          reject(error);
          controller.abort();
        });
        child.stdin?.end(input);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

export class WindowsWorkspaceStorage implements WorkspaceStoragePort {
  #parentCommitTimeoutMs: number | undefined;

  #commitTimeout(): number {
    if (this.#parentCommitTimeoutMs !== undefined) return this.#parentCommitTimeoutMs;
    if (process.env.HONEYBEE_PARENT_COMMIT_TIMEOUT_MS !== undefined) {
      throw new WorkspaceCoreError(
        "storage.invalid-timeout",
        `HONEYBEE_PARENT_COMMIT_TIMEOUT_MS is no longer supported. Commits have no total deadline; use ${COMMIT_IDLE_ENV} only for stalled progress.`,
      );
    }
    const raw = process.env[COMMIT_IDLE_ENV]?.trim();
    const value = raw === undefined ? COMMIT_IDLE_MS : Number(raw);
    if (
      (raw !== undefined && !/^\d+$/u.test(raw)) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 2_147_483_647
    ) {
      throw new WorkspaceCoreError(
        "storage.invalid-timeout",
        `${COMMIT_IDLE_ENV} must be an integer from 1 to 2147483647 milliseconds.`,
      );
    }
    this.#parentCommitTimeoutMs = value;
    return value;
  }

  public async beginParent(
    command: StorageCommand,
    compatibilityKey: string,
    layout?: "external-bee-dag-v1",
  ): Promise<StorageParentBuild> {
    // Validate before creating a pending transaction or copying the Library.
    this.#commitTimeout();
    const response = await run(command, [
      "parent",
      "begin",
      "--compatibility-key",
      compatibilityKey,
      ...(layout === undefined ? [] : ["--layout", layout]),
      "--request-id",
      `hb-parent-begin-${randomUUID()}`,
    ]);
    const parent =
      typeof response.parent === "object" && response.parent !== null
        ? object(response.parent, "parent")
        : undefined;
    const metrics =
      typeof response.metrics === "object" && response.metrics !== null
        ? object(response.metrics, "metrics")
        : undefined;
    return {
      ...(typeof response.transactionId === "string"
        ? { transactionId: response.transactionId }
        : {}),
      ...(typeof response.stagingPath === "string" ? { stagingPath: response.stagingPath } : {}),
      ...(typeof parent?.parentId === "string" ? { parentId: parent.parentId } : {}),
      ...(typeof metrics?.parentAllocatedBytes === "number"
        ? { allocatedBytes: metrics.parentAllocatedBytes }
        : {}),
    };
  }

  public async commitParent(
    command: StorageCommand,
    transactionId: string,
  ): Promise<StorageParentBuild> {
    const idleTimeoutMs = this.#commitTimeout();
    const requestId = `hb-parent-commit-${randomUUID()}`;
    const started = performance.now();
    const observe = async (target = true, signal?: AbortSignal): Promise<JsonObject> => {
      const queryId = `hb-commit-observe-${randomUUID()}`;
      const response = await run(
        command,
        ["control"],
        JSON.stringify({
          schemaVersion: 3,
          operation: "observe-parent-commit",
          requestId: queryId,
          ...(target ? { targetRequestId: requestId, transactionId } : {}),
        }) + "\n",
        COMMIT_QUERY_MS,
        { control: true, ...(signal === undefined ? {} : { signal }) },
      );
      if (response.requestId !== queryId)
        throw new Error("Commit observation request identity mismatch.");
      const observation = object(response.commitObservation, "commitObservation");
      if (
        observation.version !== 1 ||
        typeof observation.brokerSessionId !== "string" ||
        observation.brokerSessionId.length === 0 ||
        observation.requestId !== (target ? requestId : "") ||
        observation.transactionId !== (target ? transactionId : "")
      ) {
        throw new Error("Invalid commit heartbeat identity or protocol.");
      }
      return observation;
    };
    // A capability failure precedes submission and is safe for ordinary cleanup.
    const capability = await observe(false).catch((cause: unknown) => {
      throw new WorkspaceCoreError(
        "storage.heartbeat-unavailable",
        "Storage service does not provide the required commit heartbeat protocol. Update the storage service before preparing a cache.",
        { cause },
      );
    });
    if (capability.state !== "capable")
      throw new WorkspaceCoreError(
        "storage.heartbeat-unavailable",
        "Storage commit heartbeat capability is unavailable.",
      );
    const controller = new AbortController();
    const watching = new AbortController();
    let phase = "awaiting-service";
    const check = (observation: JsonObject): JsonObject | undefined => {
      if (observation.brokerSessionId !== capability.brokerSessionId)
        throw new Error("Storage service session changed; commit outcome is unknown.");
      if (observation.state === "completed") {
        const result = object(observation.result, "commit result");
        if (result.requestId !== requestId) throw new Error("Completed commit identity mismatch.");
        const parsed = parseResponse(JSON.stringify(result), "parent commit");
        const parent = object(parsed.parent, "parent");
        const key = object(parent.compatibilityKey, "parent.compatibilityKey");
        return {
          parent: {
            parentId: text(key.digest, "parent digest"),
            allocatedBytes: parent.allocatedBytes,
          },
        };
      }
      if (observation.state !== "running" && observation.state !== "unknown")
        throw new Error("Invalid commit observation state.");
      return undefined;
    };
    const monitor = async (): Promise<JsonObject> => {
      let lastHeartbeat = performance.now();
      let lastProgress = lastHeartbeat;
      let sequence = -1;
      while (!watching.signal.aborted) {
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timer);
            watching.signal.removeEventListener("abort", stop);
            resolve();
          };
          const timer = setTimeout(stop, COMMIT_POLL_MS);
          watching.signal.addEventListener("abort", stop, { once: true });
        });
        if (watching.signal.aborted) break;
        let observation: JsonObject;
        try {
          observation = await observe(true, watching.signal);
        } catch (error) {
          if (watching.signal.aborted) break;
          if (performance.now() - lastHeartbeat >= COMMIT_HEARTBEAT_MS) throw error;
          continue;
        }
        const completed = check(observation);
        if (completed !== undefined) return completed;
        lastHeartbeat = performance.now();
        if (observation.state === "running") {
          const next = observation.sequence;
          if (
            typeof next !== "number" ||
            !Number.isSafeInteger(next) ||
            next < 1 ||
            next < sequence ||
            typeof observation.phase !== "string"
          )
            throw new Error("Invalid or regressed worker progress.");
          phase = observation.phase;
          if (next > sequence) {
            sequence = next;
            lastProgress = lastHeartbeat;
          }
        }
        if (performance.now() - lastProgress >= idleTimeoutMs)
          throw new Error(
            `Parent commit progress stalled for ${idleTimeoutMs}ms (phase=${phase}).`,
          );
      }
      return new Promise<JsonObject>(() => {});
    };
    try {
      const commit = run(
        command,
        ["parent", "commit", "--transaction-id", transactionId, "--request-id", requestId],
        undefined,
        null,
        { signal: controller.signal },
      );
      let response: JsonObject;
      try {
        response = await Promise.race([commit, monitor()]);
      } catch (error) {
        const definite =
          error instanceof StorageResponseError &&
          COMPLETED_COMMIT_FAILURES.has(error.upstreamCode ?? "");
        const notStarted =
          error instanceof WorkspaceCoreError &&
          ["storage.command-not-found", "storage.command-start-failed"].includes(error.code);
        if (definite || notStarted) throw error;
        watching.abort();
        // One read-only final reconciliation, never resubmit commit or abort.
        let completed: JsonObject | undefined;
        try {
          completed = check(await observe());
        } catch (queryError) {
          if (
            queryError instanceof StorageResponseError &&
            COMPLETED_COMMIT_FAILURES.has(queryError.upstreamCode ?? "")
          )
            throw queryError;
        }
        if (completed === undefined) throw error;
        response = completed;
      }
      const parent = object(response.parent, "parent");
      return {
        parentId: text(parent.parentId, "parent.parentId"),
        ...(typeof parent.allocatedBytes === "number"
          ? { allocatedBytes: parent.allocatedBytes }
          : {}),
      };
    } catch (error) {
      const confirmedFailure =
        error instanceof StorageResponseError &&
        COMPLETED_COMMIT_FAILURES.has(error.upstreamCode ?? "");
      const notStarted =
        error instanceof WorkspaceCoreError &&
        ["storage.command-not-found", "storage.command-start-failed"].includes(error.code);
      const details = `parent commit; requestId=${requestId}; transactionId=${transactionId}; idleTimeoutMs=${idleTimeoutMs}; phase=${phase}; elapsedMs=${Math.round(performance.now() - started)}`;
      if ((confirmedFailure || notStarted) && error instanceof WorkspaceCoreError) {
        throw new WorkspaceCoreError(error.code, `${error.message} (${details})`, {
          cause: error,
          remediation: error.remediation,
          ...(error.upstreamCode === undefined ? {} : { upstreamCode: error.upstreamCode }),
        });
      }
      throw new WorkspaceCoreError(
        "storage.commit-outcome-unknown",
        `Parent commit completion could not be confirmed. Storage may still be working; do not retry or clean up before transaction-specific diagnosis. ${error instanceof Error ? error.message : String(error)} (${details})`,
        {
          cause: error,
          ...(error instanceof WorkspaceCoreError && error.upstreamCode !== undefined
            ? { upstreamCode: error.upstreamCode }
            : {}),
          remediation: [
            "The storage service may still be committing. Automatic parent cleanup was skipped; the registered cache is unchanged.",
            "Keep these request and transaction IDs. Do not immediately retry, abort, delete storage files, or restart the service.",
            "Run honeybee doctor for read-only health diagnostics and seek transaction-specific diagnosis before recovery. Doctor cannot confirm this commit's outcome.",
          ],
        },
      );
    } finally {
      watching.abort();
      controller.abort();
    }
  }

  public async abortParent(command: StorageCommand, transactionId: string): Promise<void> {
    await run(command, [
      "parent",
      "abort",
      "--transaction-id",
      transactionId,
      "--request-id",
      `hb-parent-abort-${randomUUID()}`,
    ]);
  }

  public async acquire(
    command: StorageCommand,
    input: Readonly<{
      consumerId: string;
      workspaceId: string;
      parentId: string;
      clientPid: number;
    }>,
  ): Promise<StorageLease> {
    const workspacePath = await this.#prepareWorkspace(input.workspaceId);
    const requestId = `hb-acquire-${randomUUID()}`;
    try {
      const response = await run(
        command,
        ["workspace", "acquire", "--request", "-"],
        JSON.stringify({
          schemaVersion: 2,
          operation: "workspace-acquire",
          requestId,
          consumerId: input.consumerId,
          workspaceId: input.workspaceId,
          parentId: input.parentId,
          clientPid: input.clientPid,
        }),
      );
      const lease = this.#lease(response);
      if (path.resolve(lease.workspacePath).toLowerCase() !== workspacePath.toLowerCase()) {
        throw new WorkspaceCoreError(
          "storage.invalid-response",
          "Workspace broker returned an unexpected workspace path.",
        );
      }
      return lease;
    } catch (error) {
      // Remove only the empty shell we created. Never recursively delete a path
      // that the broker (or another process) may already have populated.
      await rmdir(workspacePath).catch(() => undefined);
      throw error;
    }
  }

  public async retain(command: StorageCommand, leaseId: string): Promise<void> {
    await this.#control(command, {
      schemaVersion: 3,
      operation: "release",
      requestId: `hb-retain-${randomUUID()}`,
      leaseId,
      retainChild: true,
    });
  }

  public async attachRetained(
    command: StorageCommand,
    consumerId: string,
    workspaceId: string,
  ): Promise<StorageLease> {
    return this.#lease(
      await this.#control(command, {
        schemaVersion: 3,
        operation: "attach-retained",
        requestId: `hb-attach-${randomUUID()}`,
        runId: consumerId,
        workspaceId,
      }),
    );
  }

  public async heartbeat(
    command: StorageCommand,
    leaseId: string,
    options: Readonly<{ inactiveOnly?: boolean }> = {},
  ): Promise<StorageLease | undefined> {
    try {
      const lease = this.#lease(
        await this.#control(command, {
          schemaVersion: 3,
          operation: "heartbeat",
          requestId: `hb-heartbeat-${randomUUID()}`,
          leaseId,
          clientPid: process.pid,
        }),
      );
      if (lease.leaseId !== leaseId) {
        throw new WorkspaceCoreError("storage.invalid-response", "Unexpected active lease.");
      }
      return lease;
    } catch (error) {
      if (
        error instanceof WorkspaceCoreError &&
        (options.inactiveOnly
          ? ["lease-not-active"]
          : ["lease-not-active", "lease-not-found", "lease-not-ready"]
        ).includes(error.upstreamCode ?? "")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  public async prepareRetainedRemoval(
    command: StorageCommand,
    consumerId: string,
    workspaceId: string,
    transactionId: string,
  ): Promise<StorageRemovalPreparation> {
    return this.#removal(
      await this.#control(command, {
        schemaVersion: 3,
        operation: "prepare-retained-removal",
        requestId: `hb-remove-prepare-${randomUUID()}`,
        runId: consumerId,
        workspaceId,
        transactionId,
      }),
      transactionId,
    );
  }

  public async commitRetainedRemoval(
    command: StorageCommand,
    consumerId: string,
    transactionId: string,
  ): Promise<StorageRemovalPreparation> {
    return this.#removal(
      await this.#control(command, {
        schemaVersion: 3,
        operation: "commit-retained-removal",
        requestId: `hb-remove-commit-${randomUUID()}`,
        runId: consumerId,
        transactionId,
      }),
      transactionId,
    );
  }

  public async abortRetainedRemoval(
    command: StorageCommand,
    consumerId: string,
    transactionId: string,
  ): Promise<StorageRemovalPreparation> {
    return this.#removal(
      await this.#control(command, {
        schemaVersion: 3,
        operation: "abort-retained-removal",
        requestId: `hb-remove-abort-${randomUUID()}`,
        runId: consumerId,
        transactionId,
      }),
      transactionId,
    );
  }

  public async serviceEvidence(command: StorageCommand) {
    const response = await run(await this.#controlCommand(command), ["service-evidence"]);
    if (response.schemaVersion !== 1)
      throw new WorkspaceCoreError(
        "storage.invalid-evidence",
        "Unsupported service evidence envelope.",
      );
    return parseStorageServiceEvidence(response.evidence);
  }

  public async diagnose(command: StorageCommand): Promise<StorageDiagnosticV1> {
    const response = await run(await this.#controlCommand(command), ["diagnose"]);
    const diagnostic = object(response.diagnostic, "diagnostic");
    return {
      serviceExists: diagnostic.serviceExists === true,
      ...(typeof diagnostic.serviceState === "string"
        ? { serviceState: diagnostic.serviceState }
        : {}),
      receiptExists: diagnostic.receiptExists === true,
      receiptValid: diagnostic.receiptValid === true,
      ...(typeof diagnostic.componentVersion === "string"
        ? { componentVersion: diagnostic.componentVersion }
        : {}),
      ...(typeof diagnostic.workspaceRoot === "string"
        ? { workspaceRoot: diagnostic.workspaceRoot }
        : {}),
      workspaceRootAccessible: diagnostic.workspaceRootAccessible === true,
      executableExists: diagnostic.executableExists === true,
      executableDigestMatches: diagnostic.executableDigestMatches === true,
      userMatches: diagnostic.userMatches === true,
    };
  }

  public async status(
    command: StorageCommand,
  ): Promise<Readonly<{ parentCount: number; manualRecoveryRequired: boolean }>> {
    const response = await run(command, [
      "workspace",
      "status",
      "--schema",
      "2",
      "--request-id",
      `hb-status-${randomUUID()}`,
    ]);
    const status = object(response.status, "status");
    if (
      typeof status.parentCount !== "number" ||
      !Number.isSafeInteger(status.parentCount) ||
      status.parentCount < 0 ||
      typeof status.manualRecoveryRequired !== "boolean"
    ) {
      throw new WorkspaceCoreError(
        "storage.invalid-response",
        "Storage status is incomplete or invalid.",
      );
    }
    return {
      parentCount: status.parentCount,
      manualRecoveryRequired: status.manualRecoveryRequired,
    };
  }

  #lease(response: JsonObject): StorageLease {
    const lease = object(response.lease, "lease");
    const metrics =
      typeof response.metrics === "object" && response.metrics !== null
        ? object(response.metrics, "metrics")
        : undefined;
    const mountPath = text(lease.mountPath, "lease.mountPath");
    return {
      leaseId: text(lease.leaseId, "lease.leaseId"),
      workspacePath:
        typeof lease.workspacePath === "string" ? lease.workspacePath : path.dirname(mountPath),
      mountPath,
      ...(typeof metrics?.childReadyAllocatedBytes === "number"
        ? { allocatedBytes: metrics.childReadyAllocatedBytes }
        : {}),
    };
  }

  #removal(response: JsonObject, expectedTransactionId: string): StorageRemovalPreparation {
    const removal = object(response.removal, "removal");
    const transactionId = text(removal.transactionId, "removal.transactionId");
    const state = text(removal.state, "removal.state");
    if (
      transactionId !== expectedTransactionId ||
      !["prepared", "committed", "aborted"].includes(state)
    ) {
      throw new WorkspaceCoreError(
        "storage.invalid-response",
        "Workspace broker returned an unexpected removal transaction.",
      );
    }
    return {
      transactionId,
      runId: text(removal.runId, "removal.runId"),
      ...(typeof removal.leaseId === "string" && removal.leaseId.length > 0
        ? { leaseId: removal.leaseId }
        : {}),
      state: state as StorageRemovalPreparation["state"],
      ...(typeof removal.expiresAt === "string" ? { expiresAt: removal.expiresAt } : {}),
    };
  }

  async #prepareWorkspace(workspaceId: string): Promise<string> {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new WorkspaceCoreError("storage.invalid-workspace", "Workspace ID is invalid.");
    }
    const programData = process.env.ProgramData ?? String.raw`C:\ProgramData`;
    const receiptPath =
      process.env.HONEYBEE_WORKSPACE_STORAGE_RECEIPT ??
      path.join(programData, "UnityWorkspaceStorage", "install-receipt.json");
    let receipt: JsonObject;
    try {
      receipt = object(JSON.parse(await readFile(receiptPath, "utf8")), "install receipt");
    } catch (error) {
      throw new WorkspaceCoreError(
        "storage.install-receipt-invalid",
        "Workspace broker install receipt could not be read.",
        { cause: error },
      );
    }
    const workspaceRoot = path.resolve(text(receipt.workspaceRoot, "workspaceRoot"));
    const rootInfo = await lstat(workspaceRoot).catch(() => undefined);
    if (rootInfo?.isDirectory() !== true || rootInfo.isSymbolicLink()) {
      throw new WorkspaceCoreError(
        "storage.workspace-root-invalid",
        "Workspace broker root must be a real directory.",
      );
    }
    const workspacePath = path.resolve(workspaceRoot, workspaceId);
    if (path.dirname(workspacePath).toLowerCase() !== workspaceRoot.toLowerCase()) {
      throw new WorkspaceCoreError("storage.invalid-workspace", "Workspace ID escaped its root.");
    }
    try {
      await mkdir(workspacePath, { recursive: false });
    } catch (error) {
      throw new WorkspaceCoreError(
        "storage.workspace-exists",
        "Workspace broker shell already exists.",
        { cause: error },
      );
    }
    return workspacePath;
  }

  async #control(command: StorageCommand, request: JsonObject): Promise<JsonObject> {
    const controlCommand = await this.#controlCommand(command);
    return run(controlCommand, ["control"], JSON.stringify(request));
  }

  async #controlCommand(command: StorageCommand): Promise<string> {
    const controlCommand = storageToolPair(command).controlCommand;
    try {
      await access(controlCommand);
    } catch (error) {
      throw new WorkspaceCoreError(
        "storage.control-command-missing",
        "HoneyBee workspace storage control companion was not found.",
        { cause: error },
      );
    }
    return controlCommand;
  }
}
