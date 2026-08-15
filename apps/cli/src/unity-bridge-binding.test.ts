import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { UnityEditorObservationV1Schema } from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import type { UnityProcessControl } from "./process-control.js";
import { FileWarmBridgeBindingResolver } from "./unity-bridge-binding.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-bridge-"));
  roots.push(root);
  return root;
};

const processControl = (identity: () => string | undefined): UnityProcessControl => ({
  captureIdentity: async () => identity(),
  drain: async () => "drained",
});

describe("FileWarmBridgeBindingResolver", () => {
  it("binds only the exact owned Editor/workspace and detects PID incarnation changes", async () => {
    const projectPath = await temporaryRoot();
    await mkdir(path.join(projectPath, ".testplay", "bridge"), { recursive: true });
    const now = new Date();
    const editorId = randomUUID();
    const workspaceId = "hb-work";
    const canonicalProjectPath = await realpath(projectPath);
    let identity: string | undefined = "win32:one";
    await writeFile(
      path.join(projectPath, ".testplay", "bridge", "handshake.json"),
      JSON.stringify({
        editor_pid: 42,
        workspace_id: workspaceId,
        project_path_real: canonicalProjectPath,
        bridge_session_id: "session-1",
        bridge_protocol_version: 3,
        editor_state: "idle",
        updated_at: now.toISOString(),
      }),
      "utf8",
    );
    const editor = UnityEditorObservationV1Schema.parse({
      schemaVersion: 1,
      editorId,
      pid: 42,
      processIdentity: identity,
      projectPath,
      workspaceId,
      ownership: "honeybee",
      ownerRunId: randomUUID(),
      ownerWorkId: "work-a",
      slotId: "editor-1",
      launchId: randomUUID(),
      state: "alive",
      pathObservation: "confirmed",
      observedAt: now.toISOString(),
    });
    const bridge = new FileWarmBridgeBindingResolver(
      () => now,
      processControl(() => identity),
    );
    const binding = await bridge.bind({
      editor,
      workspaceId,
      workspacePath: projectPath,
      timeoutMs: 1000,
    });
    expect(binding).toMatchObject({ editorId, workspaceId, bridgeSessionId: "session-1" });
    await bridge.verify(binding);
    identity = "win32:reused";
    await expect(bridge.verify(binding)).rejects.toMatchObject({ code: "bridge.binding-changed" });
  });

  it("never binds a user-owned observation", async () => {
    const projectPath = await temporaryRoot();
    const editor = UnityEditorObservationV1Schema.parse({
      schemaVersion: 1,
      editorId: randomUUID(),
      pid: 42,
      processIdentity: "identity",
      projectPath,
      ownership: "user",
      state: "alive",
      pathObservation: "confirmed",
      observedAt: new Date().toISOString(),
    });
    const bridge = new FileWarmBridgeBindingResolver();
    await expect(
      bridge.bind({ editor, workspaceId: "hb-work", workspacePath: projectPath, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "validation.invalid-workflow" });
  });

  it.skipIf(process.platform !== "win32")("rejects a linked handshake directory", async () => {
    const projectPath = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(path.join(outside, "bridge"), { recursive: true });
    await symlink(outside, path.join(projectPath, ".testplay"), "junction");
    const editor = UnityEditorObservationV1Schema.parse({
      schemaVersion: 1,
      editorId: randomUUID(),
      pid: 42,
      processIdentity: "identity",
      projectPath,
      workspaceId: "hb-work",
      ownership: "honeybee",
      ownerRunId: randomUUID(),
      ownerWorkId: "work-a",
      slotId: "editor-1",
      launchId: randomUUID(),
      state: "alive",
      pathObservation: "confirmed",
      observedAt: new Date().toISOString(),
    });
    const bridge = new FileWarmBridgeBindingResolver(
      () => new Date(),
      processControl(() => "identity"),
    );
    await expect(
      bridge.bind({ editor, workspaceId: "hb-work", workspacePath: projectPath, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "bridge.binding-mismatch" });
  });
});
