import { randomUUID } from "node:crypto";

import type { IPty } from "node-pty";

import {
  DesktopPtySessionV1Schema,
  DesktopPtySnapshotV1Schema,
  type DesktopPtyKindV1,
  type DesktopPtySessionV1,
  type DesktopPtySnapshotV1,
} from "../shared/ipc.js";

const MAX_CHUNKS = 1_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_CHARACTERS = 65_536;

type PtyModule = Pick<typeof import("node-pty"), "spawn">;

export interface DesktopPtyLaunch {
  readonly profileId: string;
  readonly kind: DesktopPtyKindV1;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly columns: number;
  readonly rows: number;
}

interface StoredChunk {
  cursor: number;
  data: string;
}

interface StoredSession {
  readonly sessionId: string;
  readonly profileId: string;
  readonly kind: DesktopPtyKindV1;
  readonly label: string;
  readonly createdAt: string;
  readonly pty: IPty;
  readonly chunks: StoredChunk[];
  bytes: number;
  cursor: number;
  state: "running" | "exited";
  exitCode?: number;
  truncated: boolean;
}

const cleanEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const sessionDto = (session: StoredSession): DesktopPtySessionV1 =>
  DesktopPtySessionV1Schema.parse({
    schemaVersion: 1,
    sessionId: session.sessionId,
    profileId: session.profileId,
    kind: session.kind,
    label: session.label,
    state: session.state,
    ...(session.state === "exited" ? { exitCode: session.exitCode ?? null } : {}),
    createdAt: session.createdAt,
  });

export class DesktopPtySessionManager {
  readonly #sessions = new Map<string, StoredSession>();

  public constructor(
    private readonly loadPty: () => Promise<PtyModule> = async () => import("node-pty"),
  ) {}

  public async create(launch: DesktopPtyLaunch): Promise<DesktopPtySessionV1> {
    const ptyModule = await this.loadPty();
    const pty = ptyModule.spawn(launch.command, [...launch.args], {
      name: "xterm-256color",
      cols: launch.columns,
      rows: launch.rows,
      cwd: launch.cwd,
      env: {
        ...cleanEnvironment(),
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      },
      ...(process.platform === "win32" ? { useConpty: true } : {}),
    });
    const session: StoredSession = {
      sessionId: randomUUID(),
      profileId: launch.profileId,
      kind: launch.kind,
      label: launch.label,
      createdAt: new Date().toISOString(),
      pty,
      chunks: [],
      bytes: 0,
      cursor: 0,
      state: "running",
      truncated: false,
    };
    this.#sessions.set(session.sessionId, session);
    pty.onData((data) => this.#append(session, data));
    pty.onExit((event) => this.#onExit(session, event));
    return sessionDto(session);
  }

  public snapshot(sessionId: string, afterCursor: number): DesktopPtySnapshotV1 {
    const session = this.#require(sessionId);
    return DesktopPtySnapshotV1Schema.parse({
      schemaVersion: 1,
      session: sessionDto(session),
      cursor: session.cursor,
      chunks: session.chunks.filter((chunk) => chunk.cursor > afterCursor),
      truncated:
        session.truncated &&
        (session.chunks[0] === undefined || afterCursor < session.chunks[0].cursor - 1),
    });
  }

  public write(sessionId: string, data: string): boolean {
    const session = this.#require(sessionId);
    if (session.state !== "running") return false;
    session.pty.write(data);
    return true;
  }

  public resize(sessionId: string, columns: number, rows: number): boolean {
    const session = this.#require(sessionId);
    if (session.state !== "running") return false;
    session.pty.resize(columns, rows);
    return true;
  }

  public close(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.state === "running") session.pty.kill();
    this.#sessions.delete(sessionId);
    return true;
  }

  public closeAll(): void {
    for (const session of this.#sessions.values()) {
      if (session.state === "running") session.pty.kill();
    }
    this.#sessions.clear();
  }

  #require(sessionId: string): StoredSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw Object.assign(new Error("PTY session was not found."), {
        code: "desktop.pty-session-not-found",
      });
    }
    return session;
  }

  #append(session: StoredSession, data: string): void {
    for (let offset = 0; offset < data.length; offset += MAX_CHUNK_CHARACTERS) {
      const value = data.slice(offset, offset + MAX_CHUNK_CHARACTERS);
      const chunk = { cursor: ++session.cursor, data: value };
      session.chunks.push(chunk);
      session.bytes += Buffer.byteLength(value, "utf8");
    }
    while (session.chunks.length > MAX_CHUNKS || session.bytes > MAX_BUFFER_BYTES) {
      const removed = session.chunks.shift();
      if (removed === undefined) break;
      session.bytes -= Buffer.byteLength(removed.data, "utf8");
      session.truncated = true;
    }
  }

  #onExit(session: StoredSession, event: { readonly exitCode: number }): void {
    session.state = "exited";
    session.exitCode = event.exitCode;
  }
}
