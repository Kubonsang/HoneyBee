import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  HoneyBeeWorkspaceCore,
  WorkspaceCoreError,
  type ProjectRecordV2,
  type WorkspaceViewV1,
} from "@honeybee/core";

import {
  formatDoctor,
  formatWorkspaceCreated,
  formatWorkspaceList,
  formatWorkspaceStatus,
} from "./human-output.js";

const execFileAsync = promisify(execFile);

export const WORKSPACE_CLI_VERSION = "0.1.0-beta.3";
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
  honeybee workspace path <name-or-id> [--project <id>] [--json]
  honeybee workspace repair <name-or-id> [--project <id>] [--json]
  honeybee workspace remove <name-or-id> [--project <id>] [--json]
  honeybee doctor [--json]
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

export const jsonEnabled = (args: readonly string[]): boolean =>
  ownArguments(args).includes("--json");

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

const resolveStorageCommand = async (
  args: readonly string[],
  requireControl = true,
): Promise<string> => {
  const explicit = option(args, "--storage-command") ?? process.env.HONEYBEE_WORKSPACE_STORAGE;
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit);
    try {
      await access(resolved);
    } catch (error) {
      throw new WorkspaceCoreError(
        "storage.command-not-found",
        `unity-workspace-storage.exe was not found: ${resolved}`,
        { cause: error },
      );
    }
    if (requireControl) await assertControlCommand(resolved);
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
      if (requireControl) await assertControlCommand(candidate);
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
    "unity-workspace-storage.exe was not found.",
    {
      remediation: [
        "Extract the complete HoneyBee CLI ZIP, add the executable to PATH, or set HONEYBEE_WORKSPACE_STORAGE.",
      ],
    },
  );
};

const assertControlCommand = async (storageCommand: string): Promise<void> => {
  const controlCommand =
    process.env.HONEYBEE_WORKSPACE_STORAGE_CONTROL ??
    path.join(path.dirname(storageCommand), "honeybee-workspace-storage-host.exe");
  try {
    await access(controlCommand);
  } catch (error) {
    throw new WorkspaceCoreError(
      "storage.control-command-missing",
      `HoneyBee workspace storage control companion was not found: ${controlCommand}`,
      { cause: error },
    );
  }
};

interface StorageToolManifest {
  readonly workspaceStorageVersion: string;
  readonly files: Readonly<Record<string, Readonly<{ sha256: string }>>>;
}

const storageManifest = async (
  storageCommand: string,
): Promise<StorageToolManifest | undefined> => {
  const target = path.join(path.dirname(storageCommand), "manifest.json");
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as Partial<StorageToolManifest>;
    if (
      typeof value.workspaceStorageVersion !== "string" ||
      typeof value.files !== "object" ||
      value.files === null
    ) {
      return undefined;
    }
    const client = value.files["unity-workspace-storage.exe"];
    const control = value.files["honeybee-workspace-storage-host.exe"];
    if (
      !/^[0-9a-f]{64}$/u.test(client?.sha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(control?.sha256 ?? "")
    ) {
      return undefined;
    }
    return value as StorageToolManifest;
  } catch {
    return undefined;
  }
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
        : formatWorkspaceCreated(workspace, command === "attach" ? "Attached" : "Created"),
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
        : formatWorkspaceList(workspaces),
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
          : formatWorkspaceStatus(workspace),
      json,
    );
    return;
  }
  if (command === "path") {
    const workspace = await core.workspaceStatus(reference, project);
    if (workspace.state === "cleanup-pending" || workspace.state === "removing") {
      throw new WorkspaceCoreError(
        "workspace.cleanup-pending",
        `Workspace "${workspace.name}" has incomplete cleanup.`,
        { remediation: [`Run honeybee workspace remove "${workspace.name}" again.`] },
      );
    }
    if (!workspace.available || workspace.state === "repair-required") {
      throw new WorkspaceCoreError(
        "workspace.repair-required",
        `Workspace "${workspace.name}" is not ready.`,
        { remediation: [`Run honeybee workspace repair "${workspace.name}".`] },
      );
    }
    write(
      json
        ? {
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            ok: true,
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            workspacePath: workspace.workspacePath,
          }
        : workspace.workspacePath,
      json,
    );
    return;
  }
  if (command === "remove") {
    const removed = await core.removeWorkspace(reference, project);
    write(
      json
        ? {
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            ok: true,
            removed: {
              workspaceId: removed.workspaceId,
              name: removed.name,
              branch: removed.branch,
            },
            branchPreserved: true,
          }
        : removed.alreadyRemoved
          ? `Workspace ${removed.name} was already removed; branch ${removed.branch} remains preserved.`
          : `Removed ${removed.name}; branch ${removed.branch} was preserved.`,
      json,
    );
    return;
  }
  throw new WorkspaceCoreError("cli.unknown-command", "Unknown workspace command.");
};

const executeDoctor = async (args: readonly string[]): Promise<void> => {
  const core = coreFor(args);
  const json = jsonEnabled(args);
  const storageCommand = await resolveStorageCommand(args, false).catch(() => undefined);
  const manifest = storageCommand === undefined ? undefined : await storageManifest(storageCommand);
  const expectedClientSha256 = manifest?.files["unity-workspace-storage.exe"]?.sha256;
  const expectedControlSha256 = manifest?.files["honeybee-workspace-storage-host.exe"]?.sha256;
  const report = await core.doctor({
    ...(storageCommand === undefined ? {} : { storageCommand }),
    ...(manifest === undefined ||
    expectedClientSha256 === undefined ||
    expectedControlSha256 === undefined
      ? {}
      : {
          expectedComponentVersion: manifest.workspaceStorageVersion,
          expectedClientSha256,
          expectedControlSha256,
        }),
  });
  write(
    json
      ? {
          schemaVersion: CLI_JSON_SCHEMA_VERSION,
          ok: true,
          ready: report.ready,
          summary: report.summary,
          checks: report.checks,
        }
      : formatDoctor(report),
    json,
  );
  if (!report.ready) process.exitCode = 1;
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
  if (args[0] === "doctor") return executeDoctor(args);
  throw new WorkspaceCoreError("cli.unknown-command", `Unknown command: ${args[0] ?? ""}`);
};
