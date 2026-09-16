import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  storageToolPair,
  validateStorageTools,
  WorkspaceToolResolver,
} from "./workspace-tool-resolution.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("storage tool resolution", () => {
  it("preserves legacy sibling paths and captures the control override", () => {
    const client = path.resolve("old release", "client.exe");
    vi.stubEnv("HONEYBEE_WORKSPACE_STORAGE_CONTROL", undefined);
    const legacy = new WorkspaceToolResolver();
    expect(legacy.resolve(client)).toEqual(storageToolPair(client));
    expect(storageToolPair("relative/client.exe").controlCommand).toBe(
      path.resolve("relative", "honeybee-workspace-storage-host.exe"),
    );
    const override = path.resolve("custom", "control.exe");
    vi.stubEnv("HONEYBEE_WORKSPACE_STORAGE_CONTROL", override);
    const explicitControl = new WorkspaceToolResolver();
    vi.stubEnv("HONEYBEE_WORKSPACE_STORAGE_CONTROL", path.resolve("other.exe"));
    expect(explicitControl.resolve(client)?.controlCommand).toBe(override);
    expect(legacy.resolve(client)?.controlCommand).toBe(
      path.join(path.dirname(client), "honeybee-workspace-storage-host.exe"),
    );
  });

  it("pins the selected pair and never falls back from an invalid managed selection", async () => {
    const managed = {
      clientCommand: path.resolve("missing.exe"),
      controlCommand: path.resolve("missing-host.exe"),
    };
    const resolver = new WorkspaceToolResolver({
      managed,
      explicit: { clientCommand: process.execPath, controlCommand: process.execPath },
    });
    managed.clientCommand = process.execPath;
    const selected = resolver.resolve(process.execPath);
    expect(selected.clientCommand).toBe(path.resolve("missing.exe"));
    expect(Object.isFrozen(selected)).toBe(true);
    await expect(validateStorageTools(selected)).rejects.toMatchObject({
      code: "storage.tools-invalid",
    });
  });

  it("checks both selected payloads including a control executable outside the client directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-tool-pair-"));
    roots.push(root);
    const clientCommand = path.join(root, "client 한글.exe");
    const controlCommand = path.join(root, "different-host.exe");
    await writeFile(clientCommand, "client");
    await writeFile(controlCommand, "host");
    const managed = {
      clientCommand,
      controlCommand,
      expectedComponentVersion: "test",
      expectedClientSha256: createHash("sha256").update("client").digest("hex"),
      expectedControlSha256: createHash("sha256").update("host").digest("hex"),
    };
    const selected = new WorkspaceToolResolver({ managed }).resolve(process.execPath);
    await expect(validateStorageTools(selected)).resolves.toBeUndefined();
    await writeFile(controlCommand, "changed");
    await expect(validateStorageTools(selected)).rejects.toMatchObject({
      code: "storage.package-integrity",
    });
    await rm(controlCommand);
    await expect(validateStorageTools(selected)).rejects.toMatchObject({
      code: "storage.control-command-missing",
    });
  });

  it("rejects relative selections and directories without changing legacy validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-tool-path-"));
    roots.push(root);
    for (const [clientCommand, code] of [
      ["relative.exe", "storage.tools-invalid"],
      [root, "storage.command-not-found"],
    ] as const) {
      const tools = new WorkspaceToolResolver({
        explicit: { clientCommand, controlCommand: process.execPath },
      }).resolve(process.execPath);
      await expect(validateStorageTools(tools)).rejects.toMatchObject({ code });
    }
    await expect(
      validateStorageTools(new WorkspaceToolResolver().resolve(path.join(root, "missing.exe"))),
    ).resolves.toBeUndefined();
  });
});
