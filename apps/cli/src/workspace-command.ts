import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  HoneyBeeWorkspaceCore,
  WorkspaceCoreError,
  type ProjectRecordV1,
  type WorkspaceTool,
  type WorkspaceViewV1,
} from "@honeybee/core";

const execFileAsync = promisify(execFile);

export const WORKSPACE_CLI_VERSION = "0.7.0";

export const WORKSPACE_HELP = `HoneyBee ${WORKSPACE_CLI_VERSION}

Workspace Core for Unity projects, Git worktrees, and external AI tools.

Usage:
  honeybee project init <unity-project> --workspace-root <path>
  honeybee project list [--json]
  honeybee cache prepare [--project <id>] [--json]
  honeybee cache status [--project <id>] [--json]
  honeybee workspace create <name> --branch <new-branch> [--base <ref>] [--json]
  honeybee workspace attach <name> --branch <existing-branch> [--json]
  honeybee workspace list [--project <id>] [--json]
  honeybee workspace status <name-or-id> [--json]
  honeybee workspace repair <name-or-id> [--json]
  honeybee workspace remove <name-or-id> [--json]
  honeybee workspace launch <name-or-id> codex|claude|unity|shell [-- <args>]
  honeybee config tool set codex|claude|unity|shell <executable>
  honeybee version

HoneyBee creates isolated storage and a real Git worktree. It does not run,
monitor, merge, push, or coordinate AI work.
`;

const honeybeeArguments = (args: readonly string[]): readonly string[] => {
  const separator = args.indexOf("--");
  return separator < 0 ? args : args.slice(0, separator);
};

const option = (args: readonly string[], name: string): string | undefined => {
  const values = honeybeeArguments(args);
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

const jsonEnabled = (args: readonly string[]): boolean =>
  honeybeeArguments(args).includes("--json");

const output = (value: unknown, json: boolean): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const projectLine = (project: ProjectRecordV1): string =>
  `${project.projectId}  ${project.label}  ${project.unityProjectPath}  cache=${project.cache === undefined ? "missing" : project.cache.seedCommit.slice(0, 12)}`;

const workspaceLine = (workspace: WorkspaceViewV1): string =>
  `${workspace.workspaceId}  ${workspace.name}  ${workspace.branch}  ${workspace.available ? (workspace.git?.dirty === true ? "dirty" : "ready") : "repair-required"}`;

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
      // Continue to the next supported installation location.
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
    // A precise configuration error is emitted below.
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

const toolValue = (value: string | undefined): WorkspaceTool => {
  if (value === "codex" || value === "claude" || value === "unity" || value === "shell") {
    return value;
  }
  throw new WorkspaceCoreError("cli.invalid-tool", "Tool must be codex, claude, unity, or shell.");
};

const executeProject = async (args: readonly string[]): Promise<void> => {
  const core = coreFor(args);
  const json = jsonEnabled(args);
  if (args[1] === "init") {
    const projectPath = required(args[2], "unity-project");
    const workspaceRoot = required(option(args, "--workspace-root"), "--workspace-root");
    const label = option(args, "--label");
    const project = await core.initProject({
      unityProjectPath: path.resolve(projectPath),
      workspaceRoot: path.resolve(workspaceRoot),
      storageCommand: await resolveStorageCommand(args),
      ...(label === undefined ? {} : { label }),
    });
    output(
      json ? { ok: true, project } : `Registered ${project.label} (${project.projectId}).`,
      json,
    );
    return;
  }
  if (args[1] === "list") {
    const projects = await core.listProjects();
    output(
      json ? { ok: true, projects } : projects.map(projectLine).join("\n") || "No projects.",
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
    output(
      json
        ? { ok: true, projectId: project.projectId, cache: project.cache }
        : `Prepared Library-only parent ${project.cache?.parentId ?? "unknown"}.`,
      json,
    );
    return;
  }
  if (args[1] === "status") {
    const projects = await core.listProjects();
    const project =
      projectReference === undefined
        ? projects.length === 1
          ? projects[0]
          : undefined
        : projects.find(
            (item) =>
              item.projectId === projectReference ||
              path.resolve(item.unityProjectPath) === path.resolve(projectReference),
          );
    if (project === undefined) {
      throw new WorkspaceCoreError("project.not-found", "Specify one registered project.");
    }
    output(
      json
        ? { ok: true, projectId: project.projectId, cache: project.cache ?? null }
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
    const base = option(args, "--base");
    const workspace = await core.createWorkspace({
      ...(project === undefined ? {} : { project }),
      name: required(args[2], "workspace name"),
      branch: required(option(args, "--branch"), "--branch"),
      ...(command === "attach" ? { existingBranch: true } : base === undefined ? {} : { base }),
    });
    output(json ? { ok: true, workspace } : workspaceLine(workspace), json);
    return;
  }
  if (command === "list") {
    const workspaces = await core.listWorkspaces(project);
    output(
      json
        ? { ok: true, workspaces }
        : workspaces.map(workspaceLine).join("\n") || "No Workspaces.",
      json,
    );
    return;
  }
  const reference = required(args[2], "workspace name or id");
  if (command === "status") {
    const workspace = await core.workspaceStatus(reference, project);
    output(json ? { ok: true, workspace } : workspaceLine(workspace), json);
    return;
  }
  if (command === "repair") {
    const workspace = await core.repairWorkspace(reference, project);
    output(json ? { ok: true, workspace } : `Repaired ${workspace.name}.`, json);
    return;
  }
  if (command === "remove") {
    await core.removeWorkspace(reference, project);
    output(
      json ? { ok: true, removed: reference } : `Removed ${reference}; its branch was preserved.`,
      json,
    );
    return;
  }
  if (command === "launch") {
    const separator = args.indexOf("--");
    const tool = toolValue(args[3]);
    const toolArgs = separator < 0 ? [] : args.slice(separator + 1);
    await core.launchWorkspace(reference, tool, toolArgs, project);
    output(
      json ? { ok: true, workspace: reference, tool } : `Launched ${tool} in ${reference}.`,
      json,
    );
    return;
  }
  throw new WorkspaceCoreError("cli.unknown-command", "Unknown workspace command.");
};

const executeConfig = async (args: readonly string[]): Promise<void> => {
  if (args[1] !== "tool" || args[2] !== "set") {
    throw new WorkspaceCoreError("cli.unknown-command", "Use config tool set.");
  }
  const tool = toolValue(args[3]);
  const executable = required(args[4], "executable");
  await coreFor(args).setTool(tool, path.resolve(executable));
  output(
    jsonEnabled(args)
      ? { ok: true, tool, executable: path.resolve(executable) }
      : `Configured ${tool}.`,
    jsonEnabled(args),
  );
};

export const tryRunWorkspaceCli = async (args: readonly string[]): Promise<boolean> => {
  const ownArguments = honeybeeArguments(args);
  if (
    args.length === 0 ||
    args[0] === "help" ||
    ownArguments.includes("--help") ||
    ownArguments.includes("-h")
  ) {
    process.stdout.write(WORKSPACE_HELP);
    return true;
  }
  if (args[0] === "version" || ownArguments.includes("--version")) {
    process.stdout.write(`${WORKSPACE_CLI_VERSION}\n`);
    return true;
  }
  if (args[0] === "project") await executeProject(args);
  else if (args[0] === "cache") await executeCache(args);
  else if (args[0] === "workspace") await executeWorkspace(args);
  else if (args[0] === "config") await executeConfig(args);
  else return false;
  return true;
};
