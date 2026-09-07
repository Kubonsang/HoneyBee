import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WorkspaceCoreError,
  type ProjectRecordV2,
  type WorkspaceRecordV2,
} from "./workspace-types.js";

export interface WorkspaceUsageEntryV1 {
  readonly id: string;
  readonly kind: "files" | "testplay-local" | "child-vhdx" | "parent-vhdx" | "testplay-shared";
  readonly scope: "workspace" | "shared";
  readonly workspaceId?: string;
  readonly logicalBytes: number | null;
  readonly allocatedBytes: number | null;
  readonly fileCount: number;
  readonly omittedLinks: number;
  readonly complete: boolean;
  readonly errors: readonly string[];
}
export interface WorkspaceUsageReportV1 {
  readonly schemaVersion: 1;
  readonly measuredAt: string;
  readonly entries: readonly WorkspaceUsageEntryV1[];
  /** Deduplicated physical file identities; shared stores are counted once. */
  readonly knownAllocatedBytes: number;
  readonly complete: boolean;
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const bytes = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function parseWorkspaceUsage(value: unknown): WorkspaceUsageReportV1 {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.measuredAt !== "string" ||
    !Number.isFinite(Date.parse(value.measuredAt)) ||
    !bytes(value.knownAllocatedBytes) ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (e: unknown) =>
        isObject(e) &&
        typeof e.id === "string" &&
        ["files", "testplay-local", "child-vhdx", "parent-vhdx", "testplay-shared"].includes(
          String(e.kind),
        ) &&
        ["workspace", "shared"].includes(String(e.scope)) &&
        (e.workspaceId === undefined || typeof e.workspaceId === "string") &&
        (e.logicalBytes === null || bytes(e.logicalBytes)) &&
        (e.allocatedBytes === null || bytes(e.allocatedBytes)) &&
        bytes(e.fileCount) &&
        bytes(e.omittedLinks) &&
        typeof e.complete === "boolean" &&
        Array.isArray(e.errors) &&
        e.errors.every((error: unknown) => typeof error === "string"),
    )
  ) {
    throw new WorkspaceCoreError(
      "usage.invalid-response",
      "Usage measurement returned invalid data.",
    );
  }
  return value as unknown as WorkspaceUsageReportV1;
}

async function commandFor(
  projects: readonly ProjectRecordV2[],
  explicit?: string,
): Promise<string> {
  const override = explicit ?? process.env.HONEYBEE_USAGE_COMMAND;
  const candidates =
    override === undefined
      ? [
          ...(process.argv[1] === undefined
            ? []
            : [path.join(path.dirname(process.argv[1]), "honeybee-usage.exe")]),
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            "../../../apps/desktop/.tools/win32-x64/honeybee-usage.exe",
          ),
          ...projects.map((p) => path.join(path.dirname(p.storageCommand), "honeybee-usage.exe")),
        ]
      : [override];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new WorkspaceCoreError(
    "usage.helper-missing",
    "The read-only usage measurement companion is missing. Extract the complete HoneyBee package.",
  );
}

export async function measureWorkspaceUsage(
  workspaces: readonly WorkspaceRecordV2[],
  projects: readonly ProjectRecordV2[],
  explicitCommand?: string,
): Promise<WorkspaceUsageReportV1> {
  const cacheRoots = new Set([
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "TestPlay",
      "Cache",
      "v1",
    ),
  ]);
  const requests: {
    workspaceId: string;
    workspacePath: string;
    unityRelativePath: string;
    leaseId: string;
    parentId: string;
    storageWorkspaceId: string;
    consumerId: string;
  }[] = [];
  const configurationErrors: WorkspaceUsageEntryV1[] = [];
  for (const workspace of workspaces) {
    const project = projects.find((p) => p.projectId === workspace.projectId);
    if (project === undefined)
      throw new WorkspaceCoreError("usage.project-missing", "Workspace project record is missing.");
    requests.push({
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      unityRelativePath: project.unityRelativePath || ".",
      leaseId: workspace.leaseId,
      parentId: workspace.parentId,
      storageWorkspaceId: workspace.storageWorkspaceId,
      consumerId: workspace.consumerId,
    });
    try {
      const config: unknown = JSON.parse(
        await readFile(
          path.join(workspace.workspacePath, project.unityRelativePath, "testplay.json"),
          "utf8",
        ),
      );
      if (
        isObject(config) &&
        isObject(config.workspace) &&
        config.workspace.cache_root !== undefined
      ) {
        if (
          typeof config.workspace.cache_root !== "string" ||
          !path.isAbsolute(config.workspace.cache_root)
        )
          throw new Error("TestPlay cache_root must be absolute.");
        cacheRoots.add(path.resolve(config.workspace.cache_root));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        configurationErrors.push({
          id: `${workspace.workspaceId}:cache-config`,
          kind: "testplay-shared",
          scope: "shared",
          logicalBytes: null,
          allocatedBytes: null,
          fileCount: 0,
          omittedLinks: 0,
          complete: false,
          errors: [error instanceof Error ? error.message : String(error)],
        });
    }
  }
  const command = await commandFor(projects, explicitCommand);
  const report = await new Promise<WorkspaceUsageReportV1>((resolve, reject) => {
    const child = execFile(
      command,
      [],
      { windowsHide: true, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new WorkspaceCoreError("usage.measurement-failed", stderr.trim() || error.message),
          );
          return;
        }
        try {
          resolve(parseWorkspaceUsage(JSON.parse(stdout)));
        } catch (reason) {
          reject(reason);
        }
      },
    );
    child.stdin?.end(
      JSON.stringify({ schemaVersion: 1, workspaces: requests, cacheRoots: [...cacheRoots] }),
    );
  });
  return configurationErrors.length === 0
    ? report
    : { ...report, complete: false, entries: [...report.entries, ...configurationErrors] };
}
