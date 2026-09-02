import { describe, expect, it } from "vitest";

import {
  DesktopIpcChannels,
  DesktopPtyCreateRequestV1Schema,
  DesktopWorkspaceCreateRequestV1Schema,
  DesktopWorkspaceV1Schema,
} from "./ipc.js";

describe("Workspace Workbench IPC", () => {
  it("exposes only Workspace, Git diff, and terminal channels", () => {
    expect(Object.values(DesktopIpcChannels)).toEqual([
      "desktop.projects.v1",
      "desktop.workspaces.v1",
      "desktop.workspace.create.v1",
      "desktop.workspace.repair.v1",
      "desktop.workspace.remove.v1",
      "desktop.git.diff.v1",
      "desktop.pty.create.v1",
      "desktop.pty.snapshot.v1",
      "desktop.pty.write.v1",
      "desktop.pty.resize.v1",
      "desktop.pty.close.v1",
    ]);
  });

  it("rejects legacy orchestration fields and storage internals", () => {
    expect(() =>
      DesktopWorkspaceCreateRequestV1Schema.parse({
        projectId: "project",
        name: "combat",
        branch: "agent/combat",
        agentId: "codex",
      }),
    ).toThrow();
    expect(() =>
      DesktopWorkspaceV1Schema.parse({
        workspaceId: "workspace",
        projectId: "project",
        name: "combat",
        workspacePath: "C:\\workspaces\\combat",
        state: "ready",
        available: true,
        branch: "agent/combat",
        baseCommit: "a".repeat(40),
        git: null,
        leaseId: "private-storage-detail",
      }),
    ).toThrow();
  });

  it("bounds terminal creation and applies stable defaults", () => {
    expect(
      DesktopPtyCreateRequestV1Schema.parse({
        projectId: "project",
        workspaceId: "workspace",
      }),
    ).toMatchObject({ columns: 120, rows: 30 });
    expect(() =>
      DesktopPtyCreateRequestV1Schema.parse({
        projectId: "project",
        workspaceId: "workspace",
        columns: 10_000,
        rows: 30,
      }),
    ).toThrow();
  });
});
