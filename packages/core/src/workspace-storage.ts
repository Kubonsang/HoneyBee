import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import path from "node:path";

import {
  WorkspaceCoreError,
  type StorageLease,
  type StorageParentBuild,
  type WorkspaceStoragePort,
  type WorkspaceToolLauncher,
} from "./workspace-types.js";

const DEFAULT_PIPE = String.raw`\\.\pipe\unity-workspace-storage-v2`;
const COMMAND_TIMEOUT_MS = 120_000;

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
    throw new WorkspaceCoreError(
      typeof body.code === "string" ? body.code : "storage.operation-failed",
      typeof body.message === "string" ? body.message : `${label} failed.`,
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
          reject(
            new WorkspaceCoreError(
              "storage.command-failed",
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
  readonly #pipeName: string;

  public constructor(pipeName = DEFAULT_PIPE) {
    this.#pipeName = pipeName;
  }

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
    const requestId = `hb-acquire-${randomUUID()}`;
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
    return this.#lease(response);
  }

  public async retain(leaseId: string): Promise<void> {
    await this.#pipe({
      schemaVersion: 2,
      operation: "release",
      requestId: `hb-retain-${randomUUID()}`,
      leaseId,
      retainChild: true,
    });
  }

  public async attachRetained(consumerId: string, workspaceId: string): Promise<StorageLease> {
    return this.#lease(
      await this.#pipe({
        schemaVersion: 2,
        operation: "attach-retained",
        requestId: `hb-attach-${randomUUID()}`,
        runId: consumerId,
        workspaceId,
      }),
    );
  }

  public async removeRetained(consumerId: string): Promise<void> {
    await this.#pipe({
      schemaVersion: 2,
      operation: "remove-retained",
      requestId: `hb-remove-${randomUUID()}`,
      runId: consumerId,
    });
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

  #pipe(request: JsonObject): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#pipeName);
      let received = "";
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          error instanceof WorkspaceCoreError
            ? error
            : new WorkspaceCoreError(
                "storage.broker-unavailable",
                "Workspace broker unavailable.",
                {
                  cause: error,
                },
              ),
        );
      };
      socket.setEncoding("utf8");
      socket.setTimeout(COMMAND_TIMEOUT_MS, () => fail(new Error("Workspace broker timed out.")));
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        received += chunk;
        const newline = received.indexOf("\n");
        if (newline < 0 || settled) return;
        try {
          const response = parseResponse(received.slice(0, newline), String(request.operation));
          settled = true;
          socket.end();
          resolve(response);
        } catch (error) {
          fail(error);
        }
      });
      socket.once("error", fail);
      socket.once("end", () => {
        if (!settled) fail(new Error("Workspace broker closed without a response."));
      });
    });
  }
}

const spawnDetached = (executable: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

export class WindowsTerminalLauncher implements WorkspaceToolLauncher {
  public async launch(executable: string, args: readonly string[], cwd: string): Promise<void> {
    const extension = path.extname(executable).toLowerCase();
    const command: readonly [string, readonly string[]] =
      extension === ".cmd" || extension === ".bat"
        ? ["cmd.exe", ["/d", "/k", "call", executable, ...args]]
        : [executable, args];
    try {
      await spawnDetached("wt.exe", ["-w", "new", "nt", "-d", cwd, command[0], ...command[1]], cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await spawnDetached(command[0], command[1], cwd);
    }
  }
}
