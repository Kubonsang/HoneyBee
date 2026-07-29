import { ProjectIdSchema, WorkspaceIdSchema } from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import {
  WorkspaceDescriptorSchema,
  type WorkspaceDescriptor,
  type WorkspacePort,
} from "./index.js";

describe("WorkspaceDescriptorSchema", () => {
  it("reuses domain identifiers and normalizes the root path", () => {
    const descriptor = WorkspaceDescriptorSchema.parse({
      id: "workspace-1",
      projectId: "project-1",
      rootPath: "  D:\\HoneyBee\\worktrees\\feature  ",
    });

    expect(descriptor).toEqual({
      id: "workspace-1",
      projectId: "project-1",
      rootPath: "D:\\HoneyBee\\worktrees\\feature",
    });
  });

  it("rejects unknown aggregate state at this narrow boundary", () => {
    const result = WorkspaceDescriptorSchema.safeParse({
      id: "workspace-1",
      projectId: "project-1",
      rootPath: "D:\\HoneyBee\\worktrees\\feature",
      storageDriver: "refs",
    });

    expect(result.success).toBe(false);
  });
});

describe("WorkspacePort", () => {
  it("supports typed lookup without owning workspace creation", async () => {
    const descriptor: WorkspaceDescriptor = {
      id: WorkspaceIdSchema.parse("workspace-1"),
      projectId: ProjectIdSchema.parse("project-1"),
      rootPath: "D:\\HoneyBee\\worktrees\\feature",
    };
    const port: WorkspacePort = {
      getById: async (id) => (id === descriptor.id ? descriptor : undefined),
      list: async () => [descriptor],
    };

    await expect(port.getById(descriptor.id)).resolves.toEqual(descriptor);
    await expect(port.list()).resolves.toEqual([descriptor]);
  });
});
