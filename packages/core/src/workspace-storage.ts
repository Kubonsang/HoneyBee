import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  WorkspaceCoreError,
  type StorageDiagnosticV1,
  type StorageLease,
  type StorageParentBuild,
  type WorkspaceStoragePort,
} from "./workspace-types.js";

const COMMAND_TIMEOUT_MS = 120_000;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

type JsonObject = Record<string, unknown>;

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
  if (response.ok !== true) {
    const body =
      typeof response.error === "object" && response.error !== null
        ? object(response.error, "error")
        : {};
    const upstreamCode = typeof body.code === "string" ? body.code : undefined;
    throw new WorkspaceCoreError(
      upstreamCode === "retained-not-found"
        ? "storage.retained-not-found"
        : "storage.operation-failed",
      typeof body.message === "string" ? body.message : `${label} failed.`,
      upstreamCode === undefined ? undefined : { upstreamCode },
    );
  }
  return response;
};

const run = (command: string, args: readonly string[], input?: string): Promise<JsonObject> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
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
    if (input !== undefined) child.stdin?.end(input);
  });

export class WindowsWorkspaceStorage implements WorkspaceStoragePort {
  public async beginParent(command: string, compatibilityKey: string): Promise<StorageParentBuild> {
    const response = await run(command, [
      "parent",
      "begin",
      "--compatibility-key",
      compatibilityKey,
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

  public async commitParent(command: string, transactionId: string): Promise<StorageParentBuild> {
    const response = await run(command, [
      "parent",
      "commit",
      "--transaction-id",
      transactionId,
      "--request-id",
      `hb-parent-commit-${randomUUID()}`,
    ]);
    const parent = object(response.parent, "parent");
    return {
      parentId: text(parent.parentId, "parent.parentId"),
      ...(typeof parent.allocatedBytes === "number"
        ? { allocatedBytes: parent.allocatedBytes }
        : {}),
    };
  }

  public async abortParent(command: string, transactionId: string): Promise<void> {
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
    command: string,
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
      await rm(workspacePath).catch(() => undefined);
      throw error;
    }
  }

  public async retain(command: string, leaseId: string): Promise<void> {
    await this.#control(command, {
      schemaVersion: 2,
      operation: "release",
      requestId: `hb-retain-${randomUUID()}`,
      leaseId,
      retainChild: true,
    });
  }

  public async attachRetained(
    command: string,
    consumerId: string,
    workspaceId: string,
  ): Promise<StorageLease> {
    return this.#lease(
      await this.#control(command, {
        schemaVersion: 2,
        operation: "attach-retained",
        requestId: `hb-attach-${randomUUID()}`,
        runId: consumerId,
        workspaceId,
      }),
    );
  }

  public async removeRetained(command: string, consumerId: string): Promise<void> {
    await this.#control(command, {
      schemaVersion: 2,
      operation: "remove-retained",
      requestId: `hb-remove-${randomUUID()}`,
      runId: consumerId,
    });
  }

  public async diagnose(command: string): Promise<StorageDiagnosticV1> {
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
    command: string,
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
    return {
      parentCount:
        typeof status.parentCount === "number" && Number.isSafeInteger(status.parentCount)
          ? status.parentCount
          : 0,
      manualRecoveryRequired: status.manualRecoveryRequired === true,
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

  async #control(command: string, request: JsonObject): Promise<JsonObject> {
    const controlCommand = await this.#controlCommand(command);
    return run(controlCommand, ["control"], JSON.stringify(request));
  }

  async #controlCommand(command: string): Promise<string> {
    const explicit = process.env.HONEYBEE_WORKSPACE_STORAGE_CONTROL;
    const controlCommand =
      explicit === undefined
        ? path.join(path.dirname(path.resolve(command)), "honeybee-workspace-storage-host.exe")
        : path.resolve(explicit);
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
