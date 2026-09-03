import { describe, expect, it } from "vitest";

import {
  DesktopCloneRequestV1Schema,
  DesktopIpcChannels,
  DesktopPtyCreateRequestV1Schema,
  DesktopResultSchema,
  DesktopWorkspaceCreateRequestV1Schema,
  DesktopWorkspaceV2Schema,
} from "./ipc.js";

describe("Workspace Workbench IPC v2", () => {
  it("exposes only onboarding, Workspace, diff, terminal, and user-triggered tool channels", () => {
    expect(Object.values(DesktopIpcChannels)).not.toContain("desktop.agent.start.v1");
    expect(Object.values(DesktopIpcChannels)).not.toContain("desktop.git.push.v1");
    expect(Object.values(DesktopIpcChannels)).toContain("desktop.project-candidates.v2");
    expect(Object.values(DesktopIpcChannels)).toContain("desktop.external.launch.v2");
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
      DesktopWorkspaceV2Schema.parse({
        workspaceId: "workspace",
        projectId: "project",
        name: "combat",
        workspacePath: "C:\\workspaces\\combat",
        state: "ready",
        available: true,
        libraryConnected: true,
        branch: "agent/combat",
        baseCommit: "a".repeat(40),
        git: null,
        leaseId: "private-storage-detail",
      }),
    ).toThrow();
  });

  it("accepts safe remotes and rejects embedded credentials", () => {
    expect(
      DesktopCloneRequestV1Schema.parse({
        url: "https://github.com/example/game.git",
        destination: "C:\\src\\game",
      }).url,
    ).toContain("github.com");
    expect(
      DesktopCloneRequestV1Schema.parse({
        url: "git@github.com:example/game.git",
        destination: "C:\\src\\game",
      }).url,
    ).toContain("git@");
    expect(() =>
      DesktopCloneRequestV1Schema.parse({
        url: "https://user:secret@example.com/game.git",
        destination: "C:\\src\\game",
      }),
    ).toThrow();
  });

  it("bounds clone destination child-name suggestions", async () => {
    const { DesktopFolderPickerRequestV1Schema } = await import("./ipc.js");
    expect(
      DesktopFolderPickerRequestV1Schema.parse({
        kind: "clone-destination",
        childName: "game",
      }).childName,
    ).toBe("game");
    expect(() =>
      DesktopFolderPickerRequestV1Schema.parse({
        kind: "clone-destination",
        childName: "a".repeat(256),
      }),
    ).toThrow();
    expect(() =>
      DesktopFolderPickerRequestV1Schema.parse({
        kind: "clone-destination",
        childName: "..\\escape",
      }),
    ).toThrow();
  });

  it("requires strict result envelopes", () => {
    const schema = DesktopResultSchema(DesktopWorkspaceV2Schema);
    expect(() =>
      schema.parse({
        ok: false,
        error: { code: "workspace.dirty", message: "Dirty", remediation: [], stack: "secret" },
      }),
    ).toThrow();
  });

  it("bounds terminal creation and applies stable defaults", () => {
    expect(
      DesktopPtyCreateRequestV1Schema.parse({ projectId: "project", workspaceId: "workspace" }),
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
