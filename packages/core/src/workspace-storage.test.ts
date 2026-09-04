import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WindowsWorkspaceStorage } from "./workspace-storage.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.HONEYBEE_WORKSPACE_STORAGE_RECEIPT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WindowsWorkspaceStorage", () => {
  it("removes an empty workspace shell when acquire fails before broker ownership", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "honeybee-storage-acquire-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const receiptPath = path.join(root, "install-receipt.json");
    await mkdir(workspaceRoot);
    await writeFile(receiptPath, JSON.stringify({ workspaceRoot }), "utf8");
    process.env.HONEYBEE_WORKSPACE_STORAGE_RECEIPT = receiptPath;

    const storage = new WindowsWorkspaceStorage();
    await expect(
      storage.acquire(path.join(root, "missing-storage-command.exe"), {
        consumerId: "test-consumer",
        workspaceId: "test-workspace",
        parentId: "test-parent",
        clientPid: process.pid,
      }),
    ).rejects.toMatchObject({ code: "storage.command-not-found" });

    await expect(access(path.join(workspaceRoot, "test-workspace"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
