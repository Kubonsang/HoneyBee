import { randomUUID } from "node:crypto";
import path from "node:path";

import { spawn, type IPty } from "node-pty";

import type { DesktopPtySessionV1, DesktopPtySnapshotV1 } from "../shared/ipc.js";
import { DesktopMainError } from "./desktop-errors.js";

const MAX_CHUNKS = 1_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

const shellEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

interface PtyEntry {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly process: IPty;
  readonly chunks: Array<{ cursor: number; data: string }>;
  cursor: number;
  state: "running" | "exited";
  exitCode: number | null;
  truncatedBefore: number;
  bufferedBytes: number;
}

const view = (entry: PtyEntry): DesktopPtySessionV1 => ({
  sessionId: entry.sessionId,
  projectId: entry.projectId,
  workspaceId: entry.workspaceId,
  cwd: entry.cwd,
  state: entry.state,
  exitCode: entry.exitCode,
});

export class DesktopPtySessionManager {
  readonly #sessions = new Map<string, PtyEntry>();
  readonly #removing = new Set<string>();
  #quitting = false;

  public requestQuit(confirm: (sessions: readonly DesktopPtySessionV1[]) => boolean): boolean {
    const running = this.list().filter((session) => session.state === "running");
    if (running.length > 0 && !confirm(running)) return false;
    this.#quitting = true;
    this.closeAll();
    return true;
  }

  public list(): DesktopPtySessionV1[] {
    return [...this.#sessions.values()].map(view);
  }

  public async withWorkspaceRemoval<T>(
    projectId: string,
    workspaceId: string,
    remove: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([projectId, workspaceId]);
    if (this.#removing.has(key))
      throw new DesktopMainError("workspace.in-use", "Workspace removal is already in progress.");
    if (
      this.list().some(
        (session) =>
          session.projectId === projectId &&
          session.workspaceId === workspaceId &&
          session.state === "running",
      )
    ) {
      throw new DesktopMainError(
        "desktop.terminal-running",
        "Close the built-in terminal before removing this Workspace.",
      );
    }
    this.#removing.add(key);
    try {
      const result = await remove();
      for (const session of this.list()) {
        if (session.projectId === projectId && session.workspaceId === workspaceId)
          this.close(session.sessionId);
      }
      return result;
    } finally {
      this.#removing.delete(key);
    }
  }

  public create(
    projectId: string,
    workspaceId: string,
    cwd: string,
    columns: number,
    rows: number,
  ): DesktopPtySessionV1 {
    if (this.#quitting) throw new DesktopMainError("desktop.quitting", "HoneyBee is closing.");
    if (this.#removing.has(JSON.stringify([projectId, workspaceId]))) {
      throw new DesktopMainError("workspace.in-use", "Workspace removal is in progress.");
    }
    const existing = this.list().find(
      (session) => session.projectId === projectId && session.workspaceId === workspaceId,
    );
    if (existing !== undefined) return existing;
    if (this.#sessions.size >= 16)
      throw new DesktopMainError(
        "desktop.terminal-limit",
        "The 16-terminal limit has been reached. Close an existing terminal first.",
      );
    const sessionId = randomUUID();
    const windowsRoot = process.env.SystemRoot;
    if (windowsRoot === undefined || !path.win32.isAbsolute(windowsRoot)) {
      throw new Error("Windows SystemRoot is unavailable.");
    }
    const terminal = spawn(
      path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo"],
      {
        name: "xterm-256color",
        cols: columns,
        rows,
        cwd,
        env: { ...shellEnvironment(), HONEYBEE_WORKSPACE_ID: workspaceId },
        useConpty: true,
      },
    );
    const entry: PtyEntry = {
      sessionId,
      projectId,
      workspaceId,
      cwd,
      process: terminal,
      chunks: [],
      cursor: 0,
      state: "running",
      exitCode: null,
      truncatedBefore: 0,
      bufferedBytes: 0,
    };
    terminal.onData((data) => {
      entry.cursor += 1;
      entry.chunks.push({ cursor: entry.cursor, data });
      entry.bufferedBytes += Buffer.byteLength(data, "utf8");
      while (entry.chunks.length > MAX_CHUNKS || entry.bufferedBytes > MAX_BUFFER_BYTES) {
        const removed = entry.chunks.shift();
        if (removed === undefined) break;
        entry.bufferedBytes -= Buffer.byteLength(removed.data, "utf8");
        entry.truncatedBefore = removed.cursor;
      }
    });
    terminal.onExit(({ exitCode }) => {
      entry.state = "exited";
      entry.exitCode = exitCode;
    });
    this.#sessions.set(sessionId, entry);
    return view(entry);
  }

  public snapshot(sessionId: string, afterCursor: number): DesktopPtySnapshotV1 {
    const entry = this.#require(sessionId);
    return {
      session: view(entry),
      cursor: entry.cursor,
      chunks: entry.chunks.filter((chunk) => chunk.cursor > afterCursor),
      truncated: afterCursor < entry.truncatedBefore,
    };
  }

  public write(sessionId: string, data: string): boolean {
    const entry = this.#require(sessionId);
    if (entry.state !== "running") return false;
    entry.process.write(data);
    return true;
  }

  public resize(sessionId: string, columns: number, rows: number): boolean {
    const entry = this.#require(sessionId);
    if (entry.state !== "running") return false;
    entry.process.resize(columns, rows);
    return true;
  }

  public close(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return false;
    if (entry.state === "running") entry.process.kill();
    this.#sessions.delete(sessionId);
    return true;
  }

  public closeAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.close(sessionId);
  }

  #require(sessionId: string): PtyEntry {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) throw new Error("Terminal session was not found.");
    return entry;
  }
}
