import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { SessionId } from "@honeybee/domain";

export interface SessionLog {
  readonly filePath: string;
  write(data: string): void;
  close(): Promise<void>;
}

export interface SessionLogFactory {
  create(sessionId: SessionId, explicitPath?: string): Promise<SessionLog>;
}

const safeFileName = (sessionId: SessionId): string =>
  sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");

class FileSessionLog implements SessionLog {
  readonly #handle: FileHandle;
  readonly #onError: (error: unknown) => void;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  public constructor(
    public readonly filePath: string,
    handle: FileHandle,
    onError: (error: unknown) => void,
  ) {
    this.#handle = handle;
    this.#onError = onError;
  }

  public write(data: string): void {
    if (this.#closed || data.length === 0) {
      return;
    }
    this.#pending = this.#pending
      .then(async () => {
        await this.#handle.appendFile(data, { encoding: "utf8" });
      })
      .catch((error: unknown) => {
        this.#onError(error);
      });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#pending;
    await this.#handle.close();
  }
}

export class FileSessionLogFactory implements SessionLogFactory {
  readonly #onError: (error: unknown) => void;
  public constructor(
    public readonly baseDirectory: string,
    onError: (error: unknown) => void = () => undefined,
  ) {
    this.#onError = onError;
  }

  public async create(sessionId: SessionId, explicitPath?: string): Promise<SessionLog> {
    const filePath = path.resolve(
      explicitPath ?? path.join(this.baseDirectory, `${safeFileName(sessionId)}.pty.log`),
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, "a");
    return new FileSessionLog(filePath, handle, this.#onError);
  }
}
