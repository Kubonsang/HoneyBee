import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  WarmBridgeBindingV1Schema,
  type UnityEditorObservationV1,
  type WarmBridgeBindingV1,
} from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError } from "@honeybee/core";

import { sameEditorProjectPath } from "./unity-editor-registry.js";
import { SystemUnityProcessControl, type UnityProcessControl } from "./process-control.js";

const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_HEARTBEAT_AGE_MS = 5_000;
const POLL_MS = 100;

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new HoneyBeeCoreError("agent.cancelled", "Warm Bridge binding was cancelled."));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new HoneyBeeCoreError("agent.cancelled", "Warm Bridge binding was cancelled."));
      },
      { once: true },
    );
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface WarmBridgeBindingResolver {
  bind(
    request: Readonly<{
      editor: UnityEditorObservationV1;
      workspaceId: string;
      workspacePath: string;
      timeoutMs: number;
      signal?: AbortSignal;
    }>,
  ): Promise<WarmBridgeBindingV1>;
  verify(binding: WarmBridgeBindingV1, signal?: AbortSignal): Promise<void>;
}

export class FileWarmBridgeBindingResolver implements WarmBridgeBindingResolver {
  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly processes: UnityProcessControl = new SystemUnityProcessControl(),
  ) {}

  public async bind(
    request: Readonly<{
      editor: UnityEditorObservationV1;
      workspaceId: string;
      workspacePath: string;
      timeoutMs: number;
      signal?: AbortSignal;
    }>,
  ): Promise<WarmBridgeBindingV1> {
    if (
      request.editor.ownership !== "honeybee" ||
      request.editor.workspaceId !== request.workspaceId ||
      request.editor.projectPath === undefined
    ) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Warm Bridge binding requires an owned Editor for the exact workspace.",
      );
    }
    const deadline = Date.now() + request.timeoutMs;
    for (;;) {
      try {
        const binding = await this.#read(
          request.editor,
          request.workspaceId,
          request.workspacePath,
        );
        if (binding.editorState === "idle") return binding;
      } catch (error) {
        if (
          error instanceof HoneyBeeCoreError &&
          !["bridge.not-ready", "bridge.busy"].includes(error.code)
        ) {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new HoneyBeeCoreError(
          "bridge.not-ready",
          "Warm Bridge did not become ready in time.",
        );
      }
      await delay(Math.min(POLL_MS, deadline - Date.now()), request.signal);
    }
  }

  public async verify(binding: WarmBridgeBindingV1, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw new HoneyBeeCoreError("agent.cancelled", "Warm Bridge verification was cancelled.");
    }
    // verify() is intentionally identity-only; construct the exact read request without
    // promoting a Registry observation or selecting a different Editor.
    const current = await this.#readRaw(binding.projectPath);
    const processIdentity = await this.processes.captureIdentity(binding.editorPid);
    if (
      processIdentity !== binding.editorProcessIdentity ||
      current.editorPid !== binding.editorPid ||
      current.bridgeSessionId !== binding.bridgeSessionId ||
      current.workspaceId !== binding.workspaceId ||
      current.bridgeProtocolVersion !== binding.bridgeProtocolVersion ||
      !sameEditorProjectPath(current.projectPath, binding.projectPath) ||
      current.editorState !== "idle"
    ) {
      throw new HoneyBeeCoreError("bridge.binding-changed", "Warm Bridge identity changed.");
    }
  }

  async #read(
    editor: UnityEditorObservationV1,
    workspaceId: string,
    workspacePath: string,
  ): Promise<WarmBridgeBindingV1> {
    const canonicalWorkspace = await realpath(workspacePath);
    const current = await this.#readRaw(canonicalWorkspace);
    const processIdentity = await this.processes.captureIdentity(editor.pid);
    if (
      processIdentity !== editor.processIdentity ||
      current.editorPid !== editor.pid ||
      current.workspaceId !== workspaceId ||
      !sameEditorProjectPath(current.projectPath, canonicalWorkspace)
    ) {
      throw new HoneyBeeCoreError(
        "bridge.binding-mismatch",
        "Warm Bridge does not belong to the assigned Editor and workspace.",
      );
    }
    if (current.editorState !== "idle") {
      throw new HoneyBeeCoreError("bridge.busy", "Warm Bridge Editor is not idle.");
    }
    return WarmBridgeBindingV1Schema.parse({
      schemaVersion: 1,
      editorId: editor.editorId,
      editorPid: editor.pid,
      editorProcessIdentity: editor.processIdentity,
      workspaceId,
      projectPath: canonicalWorkspace,
      bridgeSessionId: current.bridgeSessionId,
      bridgeProtocolVersion: 3,
      editorState: "idle",
      heartbeatAt: current.heartbeatAt,
      boundAt: this.now().toISOString(),
    });
  }

  async #readRaw(projectPath: string): Promise<
    Readonly<{
      editorPid: number;
      workspaceId: string;
      projectPath: string;
      bridgeSessionId: string;
      bridgeProtocolVersion: number;
      editorState: string;
      heartbeatAt: string;
    }>
  > {
    const canonicalProject = await realpath(projectPath);
    let directory = canonicalProject;
    for (const component of [".testplay", "bridge"]) {
      directory = path.join(directory, component);
      let entry;
      try {
        entry = await lstat(directory);
      } catch {
        throw new HoneyBeeCoreError("bridge.not-ready", "Warm Bridge directory is absent.");
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new HoneyBeeCoreError("bridge.binding-mismatch", "Warm Bridge path contains a link.");
      }
    }
    const handshakePath = path.join(directory, "handshake.json");
    let initial;
    try {
      initial = await lstat(handshakePath);
    } catch {
      throw new HoneyBeeCoreError("bridge.not-ready", "Warm Bridge handshake is absent.");
    }
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.nlink !== 1 ||
      initial.size > MAX_HANDSHAKE_BYTES
    ) {
      throw new HoneyBeeCoreError(
        "bridge.binding-mismatch",
        "Warm Bridge handshake is not a private bounded file.",
      );
    }
    const handle = await open(handshakePath, "r");
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== initial.dev ||
        opened.ino !== initial.ino ||
        opened.size > MAX_HANDSHAKE_BYTES
      ) {
        throw new HoneyBeeCoreError(
          "bridge.binding-mismatch",
          "Warm Bridge handshake changed while opening.",
        );
      }
      bytes = Buffer.alloc(opened.size);
      const read = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (read.bytesRead !== bytes.byteLength) {
        throw new HoneyBeeCoreError("bridge.not-ready", "Warm Bridge handshake was incomplete.");
      }
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new HoneyBeeCoreError("bridge.not-ready", "Warm Bridge handshake is malformed.");
    }
    if (!isRecord(parsed)) {
      throw new HoneyBeeCoreError("bridge.binding-mismatch", "Warm Bridge handshake is invalid.");
    }
    const editorPid = parsed.editor_pid;
    const workspaceId = parsed.workspace_id;
    const projectPathReal = parsed.project_path_real;
    const bridgeSessionId = parsed.bridge_session_id;
    const bridgeProtocolVersion = parsed.bridge_protocol_version;
    const editorState = parsed.editor_state;
    const heartbeatAt = parsed.updated_at;
    if (
      !Number.isInteger(editorPid) ||
      (editorPid as number) <= 0 ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      typeof projectPathReal !== "string" ||
      !path.isAbsolute(projectPathReal) ||
      typeof bridgeSessionId !== "string" ||
      bridgeSessionId.length === 0 ||
      bridgeProtocolVersion !== 3 ||
      typeof editorState !== "string" ||
      typeof heartbeatAt !== "string"
    ) {
      throw new HoneyBeeCoreError(
        "bridge.binding-mismatch",
        "Warm Bridge protocol 3 identity is invalid.",
      );
    }
    const heartbeat = Date.parse(heartbeatAt);
    if (
      !Number.isFinite(heartbeat) ||
      Math.abs(this.now().getTime() - heartbeat) > MAX_HEARTBEAT_AGE_MS
    ) {
      throw new HoneyBeeCoreError("bridge.not-ready", "Warm Bridge heartbeat is stale.");
    }
    return {
      editorPid: editorPid as number,
      workspaceId,
      projectPath: path.resolve(projectPathReal),
      bridgeSessionId,
      bridgeProtocolVersion,
      editorState,
      heartbeatAt,
    };
  }
}
