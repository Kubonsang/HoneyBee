import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  WORKSPACE_REGISTRY_SCHEMA_VERSION,
  WorkspaceCoreError,
  type ProjectRecordV1,
  type WorkspaceRecordV1,
  type WorkspaceRegistryV1,
  type WorkspaceTool,
} from "./workspace-types.js";

const emptyRegistry = (): WorkspaceRegistryV1 => ({
  schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
  projects: [],
  workspaces: [],
  tools: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertRegistry = (value: unknown): WorkspaceRegistryV1 => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== WORKSPACE_REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.workspaces) ||
    !isRecord(value.tools)
  ) {
    throw new WorkspaceCoreError(
      "registry.invalid",
      "The HoneyBee Workspace registry is invalid or uses an unsupported schema.",
    );
  }
  return value as unknown as WorkspaceRegistryV1;
};

export class WorkspaceRegistryStore {
  readonly #registryPath: string;

  public constructor(dataRoot: string) {
    this.#registryPath = path.resolve(dataRoot, "workspace-registry-v1.json");
  }

  public get path(): string {
    return this.#registryPath;
  }

  public async read(): Promise<WorkspaceRegistryV1> {
    try {
      return assertRegistry(JSON.parse(await readFile(this.#registryPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
      if (error instanceof WorkspaceCoreError) throw error;
      throw new WorkspaceCoreError("registry.invalid", "Could not read the Workspace registry.", {
        cause: error,
      });
    }
  }

  public async write(value: WorkspaceRegistryV1): Promise<void> {
    const registry = assertRegistry(value);
    await mkdir(path.dirname(this.#registryPath), { recursive: true });
    const temporary = `${this.#registryPath}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#registryPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  public async update(
    change: (current: WorkspaceRegistryV1) => WorkspaceRegistryV1,
  ): Promise<WorkspaceRegistryV1> {
    const next = change(await this.read());
    await this.write(next);
    return next;
  }

  public async putProject(project: ProjectRecordV1): Promise<void> {
    await this.update((current) => ({
      ...current,
      projects: [
        ...current.projects.filter((item) => item.projectId !== project.projectId),
        project,
      ],
    }));
  }

  public async putWorkspace(workspace: WorkspaceRecordV1): Promise<void> {
    await this.update((current) => ({
      ...current,
      workspaces: [
        ...current.workspaces.filter((item) => item.workspaceId !== workspace.workspaceId),
        workspace,
      ],
    }));
  }

  public async removeWorkspace(workspaceId: string): Promise<void> {
    await this.update((current) => ({
      ...current,
      workspaces: current.workspaces.filter((item) => item.workspaceId !== workspaceId),
    }));
  }

  public async setTool(tool: WorkspaceTool, executable: string): Promise<void> {
    await this.update((current) => ({
      ...current,
      tools: { ...current.tools, [tool]: executable },
    }));
  }
}
