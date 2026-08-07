import type {
  TerminalRunCloseMessage,
  TerminalRunDataMessage,
  TerminalRunKey,
  TerminalRunOpenMessage,
  TerminalRunResetMessage,
  TerminalRunSnapshotMessage,
} from "../contracts.js";

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

/** Content-free xterm state observed after one queued write has been parsed. */
export interface TerminalRenderMetrics {
  readonly bufferLineCount: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly rows: number;
  readonly columns: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
}

export interface TerminalWriteObserver {
  readonly onWriteCalled?: (metrics: TerminalRenderMetrics) => void;
  readonly onParsed?: (metrics: TerminalRenderMetrics) => void;
  readonly onAnimationFrame?: (metrics: TerminalRenderMetrics) => void;
}

export interface TerminalSurface {
  write(data: string, observer?: TerminalWriteObserver): void;
  reset(): void;
  setVisible(visible: boolean): void;
  fit(): TerminalDimensions | undefined;
  focus(): void;
  dispose(): void;
}

export interface TerminalSurfaceFactory {
  create(key: TerminalRunKey, onData: (data: string) => void): TerminalSurface;
}

export interface TerminalRunRegistryOptions {
  readonly factory: TerminalSurfaceFactory;
  readonly onInput: (key: TerminalRunKey, data: string) => void;
  readonly onResize: (key: TerminalRunKey, size: TerminalDimensions) => void;
  readonly onSnapshotRequest: (key: TerminalRunKey, afterSeq?: number) => void;
  readonly onDiagnostic?: (code: string, key: TerminalRunKey, seq?: number) => void;
  readonly onTrace?: (event: TerminalRunRegistryTrace) => void;
  readonly maxTerminalSurfaces?: number;
  readonly now?: () => number;
}

/** Content-free delivery trace used by focused tests and temporary diagnostics. */
export type TerminalRunRegistryTrace =
  | {
      readonly stage: "registry-received";
      readonly key: TerminalRunKey;
      readonly seq: number;
      readonly status: "active" | "ended" | "interrupted" | "missing";
      readonly lastAppliedSeq: number;
    }
  | {
      readonly stage: "registry-result";
      readonly key: TerminalRunKey;
      readonly seq: number;
      readonly result: TerminalDataApplyResult["status"];
      readonly lastAppliedSeq: number;
    }
  | {
      readonly stage: "surface-write-called" | "xterm-write-callback" | "animation-frame";
      readonly key: TerminalRunKey;
      readonly seq: number;
      readonly metrics: TerminalRenderMetrics;
    };

interface SurfaceRecord {
  readonly key: TerminalRunKey;
  readonly surface: TerminalSurface;
  status: "active" | "ended" | "interrupted";
  lastAppliedSeq: number;
  lastAccessedAt: number;
  lastSize: TerminalDimensions | undefined;
  degraded: "sequence-gap" | "truncated" | undefined;
}

export type TerminalDataApplyResult =
  | { readonly status: "applied" }
  | { readonly status: "duplicate" }
  | { readonly status: "gap"; readonly expectedSeq: number }
  | { readonly status: "missing" };

export const terminalRunKey = (key: TerminalRunKey): string =>
  JSON.stringify([key.sessionId, key.runId]);

const sameKey = (left: TerminalRunKey | undefined, right: TerminalRunKey): boolean =>
  left?.sessionId === right.sessionId && left.runId === right.runId;

/**
 * Owns one independent terminal emulator surface per Session Run.
 * Surfaces stay alive across Session selection changes until bounded terminal retention evicts them.
 */
export class TerminalRunRegistry {
  readonly #records = new Map<string, SurfaceRecord>();
  readonly #factory: TerminalSurfaceFactory;
  readonly #onInput: TerminalRunRegistryOptions["onInput"];
  readonly #onResize: TerminalRunRegistryOptions["onResize"];
  readonly #onSnapshotRequest: TerminalRunRegistryOptions["onSnapshotRequest"];
  readonly #onDiagnostic: NonNullable<TerminalRunRegistryOptions["onDiagnostic"]>;
  readonly #onTrace: NonNullable<TerminalRunRegistryOptions["onTrace"]>;
  readonly #maxTerminalSurfaces: number;
  readonly #now: () => number;
  #selectedKey: TerminalRunKey | undefined;
  #selectedInteractive = false;
  #lifecycleActive = true;

  public constructor(options: TerminalRunRegistryOptions) {
    this.#factory = options.factory;
    this.#onInput = options.onInput;
    this.#onResize = options.onResize;
    this.#onSnapshotRequest = options.onSnapshotRequest;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onTrace = options.onTrace ?? (() => undefined);
    this.#maxTerminalSurfaces = options.maxTerminalSurfaces ?? 8;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxTerminalSurfaces) || this.#maxTerminalSurfaces <= 0) {
      throw new RangeError("maxTerminalSurfaces must be a positive safe integer.");
    }
  }

  public get size(): number {
    return this.#records.size;
  }

  public has(key: TerminalRunKey): boolean {
    return this.#records.has(terminalRunKey(key));
  }

  public open(message: TerminalRunOpenMessage): void {
    const existing = this.#records.get(terminalRunKey(message));
    if (existing !== undefined) {
      existing.status = message.status;
      existing.lastAccessedAt = this.#now();
      if (sameKey(this.#selectedKey, message)) {
        existing.surface.setVisible(true);
        this.fitSelected();
        this.#reportDegraded(existing);
      }
      this.#enforceRetention();
      return;
    }

    const record = this.#create(message, message.status);
    if (message.initial.kind === "replay") {
      record.surface.write(message.initial.data);
      record.lastAppliedSeq = message.initial.lastSeq;
      if (message.initial.truncatedBytes > 0) {
        record.degraded = "truncated";
        this.#reportDegraded(record);
      }
    }
    const selected = sameKey(this.#selectedKey, message);
    record.surface.setVisible(selected);
    if (selected) this.fitSelected();
    this.#enforceRetention();
  }

  public applyData(message: TerminalRunDataMessage): TerminalDataApplyResult {
    const record = this.#records.get(terminalRunKey(message));
    this.#onTrace({
      stage: "registry-received",
      key: { sessionId: message.sessionId, runId: message.runId },
      seq: message.seq,
      status: record?.status ?? "missing",
      lastAppliedSeq: record?.lastAppliedSeq ?? 0,
    });
    if (record === undefined) {
      if (sameKey(this.#selectedKey, message)) {
        this.#onDiagnostic("terminal-run-surface-missing", message, message.seq);
        this.#onSnapshotRequest({ sessionId: message.sessionId, runId: message.runId });
      }
      this.#recordResult(message, "missing", 0);
      return { status: "missing" };
    }
    if (record.status !== "active") {
      this.#onDiagnostic("terminal-run-stale-data", message, message.seq);
      this.#recordResult(message, "duplicate", record.lastAppliedSeq);
      return { status: "duplicate" };
    }
    if (message.seq <= record.lastAppliedSeq) {
      this.#onDiagnostic("terminal-run-stale-data", message, message.seq);
      this.#recordResult(message, "duplicate", record.lastAppliedSeq);
      return { status: "duplicate" };
    }
    const expectedSeq = record.lastAppliedSeq + 1;
    record.surface.write(message.data, {
      onWriteCalled: (metrics) => {
        this.#recordSurfaceTrace("surface-write-called", record.key, message.seq, metrics);
      },
      onParsed: (metrics) => {
        this.#recordSurfaceTrace("xterm-write-callback", record.key, message.seq, metrics);
      },
      onAnimationFrame: (metrics) => {
        this.#recordSurfaceTrace("animation-frame", record.key, message.seq, metrics);
      },
    });
    record.lastAppliedSeq = message.seq;
    record.lastAccessedAt = this.#now();
    if (message.seq !== expectedSeq) {
      record.degraded = "sequence-gap";
      this.#reportDegraded(record);
      this.#onSnapshotRequest(record.key, expectedSeq - 1);
      this.#recordResult(message, "gap", record.lastAppliedSeq);
      return { status: "gap", expectedSeq };
    }
    this.#recordResult(message, "applied", record.lastAppliedSeq);
    return { status: "applied" };
  }

  public restore(message: TerminalRunSnapshotMessage): void {
    const id = terminalRunKey(message);
    const previous = this.#records.get(id);
    previous?.surface.dispose();
    this.#records.delete(id);
    const record = this.#create(message, message.status);
    record.surface.write(message.data);
    record.lastAppliedSeq = message.lastSeq;
    if (message.truncatedBytes > 0) {
      record.degraded = "truncated";
      this.#reportDegraded(record);
    }
    const selected = sameKey(this.#selectedKey, message);
    record.surface.setVisible(selected);
    if (selected) this.fitSelected();
    this.#enforceRetention();
  }

  public reset(message: TerminalRunResetMessage): void {
    const record = this.#records.get(terminalRunKey(message));
    if (record === undefined) {
      this.#onDiagnostic("terminal-run-surface-missing", message);
      return;
    }
    record.surface.reset();
    record.degraded = undefined;
    record.lastAccessedAt = this.#now();
  }

  public close(message: TerminalRunCloseMessage): void {
    const record = this.#records.get(terminalRunKey(message));
    if (record === undefined) return;
    record.status = "ended";
    record.lastAppliedSeq = Math.max(record.lastAppliedSeq, message.finalSeq);
    record.lastAccessedAt = this.#now();
    this.#enforceRetention();
  }

  public select(key: TerminalRunKey | undefined, interactive: boolean): void {
    const previous = this.#selectedKey;
    if (previous !== undefined && !sameKey(previous, key ?? { sessionId: "", runId: "" })) {
      this.#records.get(terminalRunKey(previous))?.surface.setVisible(false);
    }
    this.#selectedKey = key;
    this.#selectedInteractive = interactive;
    if (key === undefined) return;
    const record = this.#records.get(terminalRunKey(key));
    if (record === undefined) return;
    record.lastAccessedAt = this.#now();
    record.surface.setVisible(true);
    this.fitSelected();
    this.#reportDegraded(record);
    this.#enforceRetention();
  }

  public setLifecycleActive(active: boolean): void {
    this.#lifecycleActive = active;
  }

  public fitSelected(): void {
    const selected = this.#selectedKey;
    if (selected === undefined) return;
    const record = this.#records.get(terminalRunKey(selected));
    if (record === undefined) return;
    const size = record.surface.fit();
    if (size === undefined || size.columns <= 0 || size.rows <= 0 || !this.#canMutate(record)) {
      return;
    }
    if (record.lastSize?.columns === size.columns && record.lastSize.rows === size.rows) {
      return;
    }
    record.lastSize = size;
    this.#onResize(record.key, size);
  }

  public focusSelected(): void {
    const selected = this.#selectedKey;
    if (selected === undefined) return;
    this.#records.get(terminalRunKey(selected))?.surface.focus();
  }

  public dispose(): void {
    for (const record of this.#records.values()) record.surface.dispose();
    this.#records.clear();
    this.#selectedKey = undefined;
  }

  #create(key: TerminalRunKey, status: SurfaceRecord["status"]): SurfaceRecord {
    const stableKey = { sessionId: key.sessionId, runId: key.runId };
    const record: SurfaceRecord = {
      key: stableKey,
      surface: this.#factory.create(stableKey, (data) => {
        const current = this.#records.get(terminalRunKey(stableKey));
        if (current !== undefined && this.#canMutate(current)) {
          this.#onInput(stableKey, data);
        }
      }),
      status,
      lastAppliedSeq: 0,
      lastAccessedAt: this.#now(),
      lastSize: undefined,
      degraded: undefined,
    };
    this.#records.set(terminalRunKey(stableKey), record);
    return record;
  }

  #reportDegraded(record: SurfaceRecord): void {
    if (!sameKey(this.#selectedKey, record.key) || record.degraded === undefined) return;
    this.#onDiagnostic(
      record.degraded === "truncated"
        ? "terminal-run-replay-truncated"
        : "terminal-run-sequence-gap",
      record.key,
      record.lastAppliedSeq,
    );
  }
  #canMutate(record: SurfaceRecord): boolean {
    return (
      this.#lifecycleActive &&
      this.#selectedInteractive &&
      record.status === "active" &&
      sameKey(this.#selectedKey, record.key)
    );
  }

  #recordResult(
    message: TerminalRunDataMessage,
    result: TerminalDataApplyResult["status"],
    lastAppliedSeq: number,
  ): void {
    this.#onTrace({
      stage: "registry-result",
      key: { sessionId: message.sessionId, runId: message.runId },
      seq: message.seq,
      result,
      lastAppliedSeq,
    });
  }

  #recordSurfaceTrace(
    stage: "surface-write-called" | "xterm-write-callback" | "animation-frame",
    key: TerminalRunKey,
    seq: number,
    metrics: TerminalRenderMetrics,
  ): void {
    this.#onTrace({ stage, key, seq, metrics });
  }

  #enforceRetention(): void {
    const terminal = [...this.#records.values()]
      .filter((record) => record.status !== "active" && !sameKey(this.#selectedKey, record.key))
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    let terminalCount = [...this.#records.values()].filter(
      (record) => record.status !== "active",
    ).length;
    for (const record of terminal) {
      if (terminalCount <= this.#maxTerminalSurfaces) break;
      this.#records.delete(terminalRunKey(record.key));
      record.surface.dispose();
      terminalCount -= 1;
      this.#onDiagnostic("terminal-run-surface-evicted", record.key);
    }
    if (
      terminalCount > this.#maxTerminalSurfaces &&
      terminal.every((record) => sameKey(this.#selectedKey, record.key))
    ) {
      const selected = this.#selectedKey;
      if (selected !== undefined) {
        this.#onDiagnostic("terminal-run-registry-limit", selected);
      }
    }
  }
}
