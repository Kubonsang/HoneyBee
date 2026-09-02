import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceRegistryStore } from "./workspace-registry.js";
import type { WorkspaceRecordV1 } from "./workspace-types.js";

const roots: string[] = [];

const workspace = (index: number): WorkspaceRecordV1 => ({
  schemaVersion: 1,
  layout: "git-worktree-library-cow-v1",
  workspaceId: `workspace-${index}`,
  projectId: "project",
  name: `work-${index}`,
  workspacePath: path.join("C:\\workspaces", String(index)),
  storageWorkspaceId: `storage-${index}`,
  storageWorkspacePath: path.join("C:\\storage", String(index)),
  mountPath: path.join("C:\\storage", String(index), "Library"),
  consumerId: `consumer-${index}`,
  leaseId: `lease-${index}`,
  parentId: "parent",
  branch: `work/${index}`,
  baseCommit: "a".repeat(40),
  state: "ready",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceRegistryStore", () => {
  it("serializes concurrent read-modify-write updates across store instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-registry-"));
    roots.push(root);
    const stores = Array.from({ length: 12 }, () => new WorkspaceRegistryStore(root));

    await Promise.all(stores.map((store, index) => store.putWorkspace(workspace(index))));

    const registry = await stores[0]?.read();
    expect(registry?.workspaces).toHaveLength(stores.length);
    expect(new Set(registry?.workspaces.map((item) => item.workspaceId))).toEqual(
      new Set(stores.map((_, index) => `workspace-${index}`)),
    );
  }, 30_000);
});
