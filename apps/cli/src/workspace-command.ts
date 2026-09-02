import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  HoneyBeeWorkspaceCore,
  WorkspaceCoreError,
  type ProjectRecordV2,
  type WorkspaceViewV1,
} from "@honeybee/core";

const execFileAsync = promisify(execFile);

export const WORKSPACE_CLI_VERSION = "0.7.0";
export const CLI_JSON_SCHEMA_VERSION = 1 as const;

export const WORKSPACE_HELP = `HoneyBee ${WORKSPACE_CLI_VERSION}

Unity parallel Workspace provider for Windows.

Usage:
  honeybee project init <unity-project> --workspace-root <path> [--json]
  honeybee project list [--json]
  honeybee cache prepare [--project <id>] [--json]
  honeybee cache status [--project <id>] [--json]
  honeybee workspace create <name> --branch <new-branch> [--base <ref>] [--project <id>] [--json]
  honeybee workspace attach <name> --branch <existing-branch> [--project <id>] [--json]
  honeybee workspace list [--project <id>] [--json]
  honeybee workspace status <name-or-id> [--project <id>] [--json]
  honeybee workspace repair <name-or-id> [--project <id>] [--json]
  honeybee workspace remove <name-or-id> [--project <id>] [--json]
  honeybee version

HoneyBee owns Git worktree and Unity Library CoW lifecycle only. Run tools
yourself from the returned Workspace path.
`;

const ownArguments = (args: readonly string[]): readonly string[] => {
  const separator = args.indexOf("--");
  return separator < 0 ? args : args.slice(0, separator);
};

const option = (args: readonly string[], name: string): string | undefined => {
  const values = ownArguments(args);
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new WorkspaceCoreError("cli.missing-option", `${name} requires a value.`);
  }
  return value;
};

const required = (value: string | undefined, label: string): string => {
  if (value === undefined || value.startsWith("--")) {
    throw new WorkspaceCoreError("cli.missing-argument", `${label} is required.`);
  }
  return value;
};

const jsonEnabled = (args: readonly string[]): boolean => ownArguments(args).includes("--json");

const write = (value: unknown, json: boolean): void => {
  process.stdout.write(
    json
      ? `${JSON.stringify(value, null, 2)}\n`
      : `${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
};

const projectDto = (project: ProjectRecordV2) => ({
  projectId: project.projectId,
  label: project.label,
  unityProjectPath: project.unityProjectPath,
  repositoryRoot: project.repositoryRoot,
  unityRelativePath: project.unityRelativePath,
  workspaceRoot: project.workspaceRoot,
  cacheState: project.cache === undefined ? ("missing" as const) : ("ready" as const),
  createdAt: project.createdAt,
});

const cacheDto = (project: ProjectRecordV2) => ({
  projectId: project.projectId,
  state: project.cache === undefined ? ("missing" as const) : ("ready" as const),
  cache:
    project.cache === undefined
      ? null
      : {
          kind: project.cache.kind,
          parentId: project.cache.parentId,
          seedCommit: project.cache.seedCommit,
          preparedAt: project.cache.preparedAt,
          ...(project.cache.allocatedBytes === undefined
            ? {}
            : { allocatedBytes: project.cache.allocatedBytes }),
        },
});

export const workspaceDto = (workspace: WorkspaceViewV1) => ({
  workspaceId: workspace.workspaceId,
  projectId: workspace.projectId,
  name: workspace.name,
  workspacePath: workspace.workspacePath,
  layout: workspace.layout,
  state: workspace.state,
  available: workspace.available,
  branch: workspace.branch,
  baseCommit: workspace.baseCommit,
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt,
  git: workspace.git ?? null,
});

const projectLine = (project: ProjectRecordV2): string =>
  `${project.projectId}  ${project.label}  ${project.unityProjectPath}  cache=${project.cache === undefined ? "missing" : "ready"}`;

const workspaceLine = (workspace: WorkspaceViewV1): string =>
  `${workspace.workspaceId}  ${workspace.name}  ${workspace.branch}  ${workspace.available ? (workspace.git?.dirty === true ? "dirty" : "ready") : workspace.state}`;

const resolveStorageCommand = async (args: readonly string[]): Promise<string> => {
  const explicit = option(args, "--storage-command") ?? process.env.HONEYBEE_WORKSPACE_STORAGE;
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit);
    await access(resolved);
    return resolved;
  }
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "unity-workspace-storage.exe"),
    path.resolve(
      moduleDirectory,
      "..",
      "..",
      "desktop",
      ".tools",
      "win32-x64",
      "unity-workspace-storage.exe",
    ),
    path.resolve(
      process.cwd(),
      "apps",
      "desktop",
      ".tools",
      "win32-x64",
      "unity-workspace-storage.exe",
    ),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the supported installation locations.
    }
  }
  try {
    const result = await execFileAsync("where.exe", ["unity-workspace-storage.exe"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const first = result.stdout.split(/\r?\n/u).find(Boolean);
    if (first !== undefined) return path.resolve(first);
  } catch {
    // Emit the stable product error below.
  }
  throw new WorkspaceCoreError(
    "storage.command-not-found",
    "unity-workspace-storage.exe was not found. Add it to PATH or set HONEYBEE_WORKSPACE_STORAGE.",
  );
};

const coreFor = (args: readonly string[]): HoneyBeeWorkspaceCore =>
  new HoneyBeeWorkspaceCore({
    ...(option(args, "--data-root") === undefined
      ? {}
      : { dataRoot: path.resolve(option(args, "--data-root") as string) }),
  });

const executeProject = async (args: readonly string[]): Promise<void> => {
  const core = coreFor(args);
  const json = jsonEnabled(args);
  if (args[1] === "init") {
    const label = option(args, "--label");
    const project = await core.initProject({
      unityProjectPath: path.resolve(required(args[2], "unity-project")),
      workspaceRoot: path.resolve(required(option(args, "--workspace-root"), "--workspace-root")),
      storageCommand: await resolveStorageCommand(args),
      ...(label === undefined ? {} : { label }),
    });
    write(
      json
        ? { schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, project: projectDto(project) }
        : `Registered ${project.label} (${project.projectId}).`,
      json,
    );
    return;
  }
  if (args[1] === "list") {
    const projects = [...(await core.listProjects())].sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.projectId.localeCompare(right.projectId),
    );
    write(
      json
        ? { schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, projects: projects.map(projectDto) }
        : projects.map(projectLine).join("\n") || "No projects.",
      json,
    );
    return;
  }
  throw new WorkspaceCoreError("cli.unknown-command", "Use project init or project list.");
};

const executeCache = async (args: readonly string[]): Promise<void> => {
  const core = coreFor(args);
  const json = jsonEnabled(args);
  const projectReference = option(args, "--project");
  if (args[1] === "prepare") {
    const project = await core.prepareCache(projectReference);
    write(
      json
        ? { schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, ...cacheDto(project) }
        : `Prepared Library-only parent ${project.cache?.parentId ?? "unknown"}.`,
      json,
    );
    return;
  }
  if (args[1] === "status") {
    const project = await core.cacheStatus(projectReference);
    write(
      json
        ? { schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, ...cacheDto(project) }
        : project.cache === undefined
          ? "Cache is not prepared."
          : `Cache ${project.cache.parentId} from ${project.cache.seedCommit}.`,
      json,
    );
    return;
  }
  throw new WorkspaceCoreError("cli.unknown-command", "Use cache prepare or cache status.");
};

const executeWorkspace = async (args: readonly string[]): Promise<void> => {
  const core = coreFor(args);
  const json = jsonEnabled(args);
  const command = args[1];
  const project = option(args, "--project");
  if (command === "create" || command === "attach") {
    const input = {
      ...(project === undefined ? {} : { project }),
      name: required(args[2], "workspace name"),
      branch: required(option(args, "--branch"), "--branch"),
    };
    const base = option(args, "--base");
    const workspace =
      command === "attach"
        ? await core.attachWorkspace(input)
        : await core.createWorkspace({ ...input, ...(base === undefined ? {} : { base }) });
    write(
      json
        ? { schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, workspace: workspaceDto(workspace) }
        : workspaceLine(workspace),
      json,
    );
    return;
  }
  if (command === "list") {
    const workspaces = [...(await core.listWorkspaces(project))].sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId),
    );
    write(
      json
        ? {
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            ok: true,
            workspaces: workspaces.map(workspaceDto),
          }
        : workspaces.map(workspaceLine).join("\n") || "No Workspaces.",
      json,
    );
    return;
  }
  const reference = required(args[2], "workspace name or id");
  if (command === "status" || command === "repair") {
    const workspace =
      command === "status"
        ? await core.workspaceStatus(reference, project)
        : await core.repairWorkspace(reference, project);
    write(
      json
        ? { schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, workspace: workspaceDto(workspace) }
        : command === "repair"
          ? `Repaired ${workspace.name}.`
          : workspaceLine(workspace),
      json,
    );
    return;
  }
  if (command === "remove") {
    const workspace = await core.workspaceStatus(reference, project);
    await core.removeWorkspace(reference, project);
    write(
      json
        ? {
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            ok: true,
            removed: {
              workspaceId: workspace.workspaceId,
              name: workspace.name,
              branch: workspace.branch,
            },
            branchPreserved: true,
          }
        : `Removed ${workspace.name}; branch ${workspace.branch} was preserved.`,
      json,
    );
    return;
  }
  throw new WorkspaceCoreError("cli.unknown-command", "Unknown workspace command.");
};

export const runWorkspaceCli = async (args: readonly string[]): Promise<void> => {
  const values = ownArguments(args);
  if (
    values.length === 0 ||
    values[0] === "help" ||
    values.includes("--help") ||
    values.includes("-h")
  ) {
    process.stdout.write(WORKSPACE_HELP);
    return;
  }
  if (values[0] === "version" || values.includes("--version")) {
    process.stdout.write(`${WORKSPACE_CLI_VERSION}\n`);
    return;
  }
  if (args[0] === "project") return executeProject(args);
  if (args[0] === "cache") return executeCache(args);
  if (args[0] === "workspace") return executeWorkspace(args);
  throw new WorkspaceCoreError("cli.unknown-command", `Unknown command: ${args[0] ?? ""}`);
};
