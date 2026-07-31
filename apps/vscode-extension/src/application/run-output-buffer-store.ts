import type { RunId, SessionId } from "@honeybee/domain";

interface OutputChunk {
  seq: number;
  data: string;
  bytes: number;
}

interface MutableRunOutputBuffer {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly chunks: OutputChunk[];
  byteLength: number;
  lastSeq: number;
  truncatedBytes: number;
  sequenceGap: boolean;
  terminal: boolean;
  finalSeq: number | undefined;
  lastAccessedAt: number;
}

export interface RunOutputSnapshot {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly data: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly truncatedBytes: number;
  readonly sequenceGap: boolean;
  readonly terminal: boolean;
  readonly finalSeq?: number;
}

export type RunOutputAppendResult =
  | { readonly status: "applied"; readonly expectedSeq: number; readonly gap: boolean }
  | { readonly status: "duplicate"; readonly lastSeq: number }
  | { readonly status: "terminal"; readonly finalSeq: number | undefined };

export interface RunOutputRetentionResult {
  readonly evictedRunIds: readonly RunId[];
  readonly limitExceeded: boolean;
}

export interface RunOutputBufferStoreOptions {
  readonly perRunBytes?: number;
  readonly totalBytes?: number;
  readonly maxTerminalRuns?: number;
  readonly now?: () => number;
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const removeUtf8Prefix = (
  value: string,
  minimumBytes: number,
): { readonly remainder: string; readonly removedBytes: number } => {
  const characters = Array.from(value);
  let removedBytes = 0;
  let index = 0;
  while (index < characters.length && removedBytes < minimumBytes) {
    const character = characters[index];
    if (character === undefined) break;
    removedBytes += utf8Bytes(character);
    index += 1;
  }
  return { remainder: characters.slice(index).join(""), removedBytes };
};

/**
 * Memory-only, sequence-aware terminal transcript storage keyed by globally unique Run ID.
 * Active and selected Runs are protected from total-memory eviction.
 */
export class RunOutputBufferStore {
  readonly #buffers = new Map<RunId, MutableRunOutputBuffer>();
  readonly #perRunBytes: number;
  readonly #totalBytes: number;
  readonly #maxTerminalRuns: number;
  readonly #now: () => number;
  #selectedRunId: RunId | undefined;

  public constructor(options: RunOutputBufferStoreOptions = {}) {
    this.#perRunBytes = options.perRunBytes ?? 512 * 1024;
    this.#totalBytes = options.totalBytes ?? 6 * 1024 * 1024;
    this.#maxTerminalRuns = options.maxTerminalRuns ?? 12;
    this.#now = options.now ?? Date.now;
    for (const [name, value] of [
      ["perRunBytes", this.#perRunBytes],
      ["totalBytes", this.#totalBytes],
      ["maxTerminalRuns", this.#maxTerminalRuns],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(name + " must be a positive safe integer.");
      }
    }
  }

  public get size(): number {
    return this.#buffers.size;
  }

  public get totalByteLength(): number {
    let total = 0;
    for (const buffer of this.#buffers.values()) total += buffer.byteLength;
    return total;
  }

  public open(sessionId: SessionId, runId: RunId): RunOutputSnapshot {
    const existing = this.#buffers.get(runId);
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId) {
        throw new Error("Run " + runId + " is already owned by another Session.");
      }
      existing.lastAccessedAt = this.#now();
      return this.#snapshot(existing);
    }
    const created: MutableRunOutputBuffer = {
      sessionId,
      runId,
      chunks: [],
      byteLength: 0,
      lastSeq: 0,
      truncatedBytes: 0,
      sequenceGap: false,
      terminal: false,
      finalSeq: undefined,
      lastAccessedAt: this.#now(),
    };
    this.#buffers.set(runId, created);
    return this.#snapshot(created);
  }

  public append(
    sessionId: SessionId,
    runId: RunId,
    seq: number,
    data: string,
  ): RunOutputAppendResult {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new RangeError("Terminal sequence must be a non-negative safe integer.");
    }
    const buffer = this.#buffer(sessionId, runId);
    if (buffer.terminal) {
      return { status: "terminal", finalSeq: buffer.finalSeq };
    }
    if (seq <= buffer.lastSeq) {
      return { status: "duplicate", lastSeq: buffer.lastSeq };
    }
    const expectedSeq = buffer.lastSeq + 1;
    const gap = seq !== expectedSeq;
    if (gap) buffer.sequenceGap = true;
    const bytes = utf8Bytes(data);
    if (bytes > 0) {
      buffer.chunks.push({ seq, data, bytes });
      buffer.byteLength += bytes;
      this.#trimRun(buffer);
    }
    buffer.lastSeq = seq;
    buffer.lastAccessedAt = this.#now();
    return { status: "applied", expectedSeq, gap };
  }

  public markTerminal(
    sessionId: SessionId,
    runId: RunId,
    finalSeq: number,
  ): RunOutputRetentionResult {
    const buffer = this.#buffer(sessionId, runId);
    buffer.terminal = true;
    buffer.finalSeq = finalSeq;
    buffer.lastAccessedAt = this.#now();
    return this.enforceRetention();
  }

  public setSelected(runId: RunId | undefined): RunOutputRetentionResult {
    this.#selectedRunId = runId;
    if (runId !== undefined) {
      const selected = this.#buffers.get(runId);
      if (selected !== undefined) selected.lastAccessedAt = this.#now();
    }
    return this.enforceRetention();
  }

  public snapshot(sessionId: SessionId, runId: RunId): RunOutputSnapshot | undefined {
    const buffer = this.#buffers.get(runId);
    if (buffer === undefined || buffer.sessionId !== sessionId) return undefined;
    buffer.lastAccessedAt = this.#now();
    return this.#snapshot(buffer);
  }

  /** Reads replay availability without changing retention recency. */
  public inspect(sessionId: SessionId, runId: RunId): RunOutputSnapshot | undefined {
    const buffer = this.#buffers.get(runId);
    return buffer === undefined || buffer.sessionId !== sessionId
      ? undefined
      : this.#snapshot(buffer);
  }

  public has(runId: RunId): boolean {
    return this.#buffers.has(runId);
  }

  public enforceRetention(): RunOutputRetentionResult {
    const evicted: RunId[] = [];
    const candidates = (): MutableRunOutputBuffer[] =>
      [...this.#buffers.values()]
        .filter((buffer) => buffer.terminal && buffer.runId !== this.#selectedRunId)
        .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);

    let terminalCount = [...this.#buffers.values()].filter((buffer) => buffer.terminal).length;
    for (const buffer of candidates()) {
      if (terminalCount <= this.#maxTerminalRuns) break;
      this.#buffers.delete(buffer.runId);
      evicted.push(buffer.runId);
      terminalCount -= 1;
    }

    for (const buffer of candidates()) {
      if (this.totalByteLength <= this.#totalBytes) break;
      this.#buffers.delete(buffer.runId);
      evicted.push(buffer.runId);
    }

    return {
      evictedRunIds: evicted,
      limitExceeded: this.totalByteLength > this.#totalBytes,
    };
  }

  #buffer(sessionId: SessionId, runId: RunId): MutableRunOutputBuffer {
    const existing = this.#buffers.get(runId);
    if (existing === undefined) {
      this.open(sessionId, runId);
      const created = this.#buffers.get(runId);
      if (created === undefined) {
        throw new Error("Run output buffer creation failed.");
      }
      return created;
    }
    if (existing.sessionId !== sessionId) {
      throw new Error("Run " + runId + " is already owned by another Session.");
    }
    return existing;
  }

  #trimRun(buffer: MutableRunOutputBuffer): void {
    while (buffer.byteLength > this.#perRunBytes && buffer.chunks.length > 0) {
      const first = buffer.chunks[0];
      if (first === undefined) break;
      const overflow = buffer.byteLength - this.#perRunBytes;
      if (first.bytes <= overflow) {
        buffer.chunks.shift();
        buffer.byteLength -= first.bytes;
        buffer.truncatedBytes += first.bytes;
        continue;
      }
      const trimmed = removeUtf8Prefix(first.data, overflow);
      first.data = trimmed.remainder;
      first.bytes -= trimmed.removedBytes;
      buffer.byteLength -= trimmed.removedBytes;
      buffer.truncatedBytes += trimmed.removedBytes;
    }
  }

  #snapshot(buffer: MutableRunOutputBuffer): RunOutputSnapshot {
    return {
      sessionId: buffer.sessionId,
      runId: buffer.runId,
      data: buffer.chunks.map((chunk) => chunk.data).join(""),
      firstSeq: buffer.chunks[0]?.seq ?? 0,
      lastSeq: buffer.lastSeq,
      truncatedBytes: buffer.truncatedBytes,
      sequenceGap: buffer.sequenceGap,
      terminal: buffer.terminal,
      ...(buffer.finalSeq === undefined ? {} : { finalSeq: buffer.finalSeq }),
    };
  }
}
