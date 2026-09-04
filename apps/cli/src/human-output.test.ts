import { describe, expect, it } from "vitest";

import { WorkspaceCoreError, type WorkspaceViewV1 } from "@honeybee/core";

import {
  formatDoctor,
  formatError,
  formatWorkspaceCreated,
  formatWorkspaceList,
  formatWorkspaceStatus,
} from "./human-output.js";

const workspace = (overrides: Partial<WorkspaceViewV1> = {}): WorkspaceViewV1 => ({
  schemaVersion: 2,
  layout: "git-worktree-library-cow-v1",
  workspaceId: "workspace",
  projectId: "project",
  name: "combat",
  workspacePath: "D:\\HoneyBee\\MyGame\\combat",
  storageWorkspaceId: "storage",
  storageWorkspacePath: "D:\\storage\\workspace",
  mountPath: "D:\\storage\\workspace\\Library",
  consumerId: "consumer",
  leaseId: "lease",
  parentId: "parent",
  branch: "agent/combat",
  baseCommit: "a".repeat(40),
  state: "ready",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  available: true,
  libraryConnected: true,
  git: {
    branch: "agent/combat",
    head: "abcdef0123456789",
    dirty: true,
    changes: [" M Assets/Combat.cs", "?? Assets/New.asset", " M Packages/manifest.json"],
  },
  ...overrides,
});

describe("human CLI output", () => {
  it("formats Workspace list and status for immediate scanning", () => {
    const value = workspace();
    expect(formatWorkspaceList([value])).toContain("combat  agent/combat  ready  3 files");
    expect(formatWorkspaceStatus(value)).toContain("HEAD       abcdef0");
    expect(formatWorkspaceStatus(value)).toContain("Library    connected");
    expect(formatWorkspaceStatus(value)).toContain("Changes    3 files");
  });

  it("shows the Workspace path and next command after create", () => {
    const output = formatWorkspaceCreated(workspace(), "Created");
    expect(output).toContain('cd "D:\\HoneyBee\\MyGame\\combat"');
  });

  it("renders stable errors with remediation without JSON", () => {
    const output = formatError(
      new WorkspaceCoreError("workspace.dirty", "Workspace contains changes.", {
        remediation: ["Commit or discard them.", 'git -C "D:\\work" status'],
      }),
    );
    expect(output).toContain("Error [workspace.dirty]");
    expect(output).toContain('git -C "D:\\work" status');
  });

  it("formats doctor checks and readiness summary", () => {
    const output = formatDoctor({
      schemaVersion: 1,
      ready: false,
      summary: { pass: 1, warning: 1, fail: 1 },
      checks: [
        { code: "git.executable", status: "pass", message: "git version 2" },
        { code: "cache.prepared", status: "warning", message: "not prepared" },
        { code: "storage.service", status: "fail", message: "not running" },
      ],
    });
    expect(output).toContain("PASS    git.executable");
    expect(output).toContain("Ready: no (1 pass, 1 warning, 1 fail)");
  });
});
