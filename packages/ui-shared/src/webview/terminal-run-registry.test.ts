import { describe, expect, it, vi } from "vitest";

import type { TerminalRunKey } from "../contracts.js";
import {
  TerminalRunRegistry,
  terminalRunKey,
  type TerminalDimensions,
  type TerminalRenderMetrics,
  type TerminalSurface,
  type TerminalSurfaceFactory,
} from "./terminal-run-registry.js";

class FakeSurface implements TerminalSurface {
  readonly writes: string[] = [];
  readonly visibility: boolean[] = [];
  resetCount = 0;
  fitCount = 0;
  focusCount = 0;
  disposeCount = 0;
  size: TerminalDimensions | undefined = { columns: 100, rows: 30 };

  public constructor(readonly input: (data: string) => void) {}

  public write(data: string, onParsed?: (metrics: TerminalRenderMetrics) => void): void {
    this.writes.push(data);
    onParsed?.({ bufferLineCount: this.writes.length, baseY: 0, viewportY: 0, rows: 30 });
  }

  public reset(): void {
    this.resetCount += 1;
  }

  public setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }

  public fit(): TerminalDimensions | undefined {
    this.fitCount += 1;
    return this.size;
  }

  public focus(): void {
    this.focusCount += 1;
  }

  public dispose(): void {
    this.disposeCount += 1;
  }
}

class FakeFactory implements TerminalSurfaceFactory {
  readonly surfaces = new Map<string, FakeSurface>();

  public create(key: TerminalRunKey, onData: (data: string) => void): TerminalSurface {
    const surface = new FakeSurface(onData);
    this.surfaces.set(terminalRunKey(key), surface);
    return surface;
  }

  public get(key: TerminalRunKey): FakeSurface {
    const surface = this.surfaces.get(terminalRunKey(key));
    if (surface === undefined) throw new Error("Surface was not created.");
    return surface;
  }
}

const key = (sessionId: string, runId: string): TerminalRunKey => ({ sessionId, runId });

const open = (identity: TerminalRunKey, status: "active" | "ended" = "active") => ({
  type: "terminal.run.open" as const,
  ...identity,
  status,
  initial: { kind: "empty" as const },
});

describe("TerminalRunRegistry", () => {
  it("creates stable composite keys without cross-Session collisions", () => {
    expect(terminalRunKey(key("ab", "c"))).not.toBe(terminalRunKey(key("a", "bc")));
  });

  it("keeps A and B surfaces isolated and reuses A without reset on selection", () => {
    const factory = new FakeFactory();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize: vi.fn(),
      onSnapshotRequest: vi.fn(),
    });
    const a = key("session-a", "run-a");
    const b = key("session-b", "run-b");

    registry.select(a, true);
    registry.open(open(a));
    registry.applyData({ type: "terminal.run.data", ...a, seq: 1, data: "\u001b[?1049hA" });
    registry.select(b, true);
    registry.open(open(b));
    registry.applyData({ type: "terminal.run.data", ...b, seq: 1, data: "B" });
    registry.select(a, true);

    expect(factory.get(a).writes).toEqual(["\u001b[?1049hA"]);
    expect(factory.get(b).writes).toEqual(["B"]);
    expect(factory.get(a).resetCount).toBe(0);
    expect(factory.get(b).resetCount).toBe(0);
    expect(factory.get(a).disposeCount).toBe(0);
  });

  it("uses a fresh surface for a new Run and never routes old Run data into it", () => {
    const factory = new FakeFactory();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize: vi.fn(),
      onSnapshotRequest: vi.fn(),
    });
    const a1 = key("session-a", "run-1");
    const a2 = key("session-a", "run-2");
    registry.open(open(a1));
    registry.close({
      type: "terminal.run.close",
      ...a1,
      reason: "process-exit-zero",
      finalSeq: 2,
    });
    registry.select(a2, true);
    registry.open(open(a2));

    registry.applyData({ type: "terminal.run.data", ...a1, seq: 3, data: "late" });
    registry.applyData({ type: "terminal.run.data", ...a2, seq: 1, data: "fresh" });

    expect(factory.get(a1).writes).toEqual([]);
    expect(factory.get(a2).writes).toEqual(["fresh"]);
  });

  it("forwards input only from the visible active interactive surface", () => {
    const factory = new FakeFactory();
    const onInput = vi.fn();
    const registry = new TerminalRunRegistry({
      factory,
      onInput,
      onResize: vi.fn(),
      onSnapshotRequest: vi.fn(),
    });
    const a = key("session-a", "run-a");
    const b = key("session-b", "run-b");
    registry.open(open(a));
    registry.open(open(b));
    registry.select(a, true);

    factory.get(b).input("hidden");
    factory.get(a).input("visible");
    registry.select(a, false);
    factory.get(a).input("archived");

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(a, "visible");
  });

  it("fits and resizes only the selected interactive Run and suppresses duplicates", () => {
    const factory = new FakeFactory();
    const onResize = vi.fn();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize,
      onSnapshotRequest: vi.fn(),
    });
    const a = key("session-a", "run-a");
    const b = key("session-b", "run-b");
    registry.open(open(a));
    registry.open(open(b));
    registry.select(a, true);
    registry.fitSelected();
    registry.select(b, false);
    registry.fitSelected();

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(a, { columns: 100, rows: 30 });
  });

  it("rejects duplicate seq and requests a snapshot for a gap", () => {
    const factory = new FakeFactory();
    const onSnapshotRequest = vi.fn();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize: vi.fn(),
      onSnapshotRequest,
    });
    const a = key("session-a", "run-a");
    registry.select(a, true);
    registry.open(open(a));

    expect(registry.applyData({ type: "terminal.run.data", ...a, seq: 1, data: "one" })).toEqual({
      status: "applied",
    });
    expect(
      registry.applyData({ type: "terminal.run.data", ...a, seq: 1, data: "duplicate" }),
    ).toEqual({ status: "duplicate" });
    expect(registry.applyData({ type: "terminal.run.data", ...a, seq: 3, data: "three" })).toEqual({
      status: "gap",
      expectedSeq: 2,
    });
    expect(onSnapshotRequest).toHaveBeenCalledWith(a, 1);
    expect(factory.get(a).writes).toEqual(["one", "three"]);
  });

  it("traces Run identity, sequence, apply result, and content-free render metrics", () => {
    const factory = new FakeFactory();
    const trace = vi.fn();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize: vi.fn(),
      onSnapshotRequest: vi.fn(),
      onTrace: trace,
    });
    const a = key("session-a", "run-a");
    registry.select(a, true);
    registry.open(open(a));

    expect(
      registry.applyData({ type: "terminal.run.data", ...a, seq: 1, data: "SESSION-A" }),
    ).toEqual({ status: "applied" });
    expect(trace.mock.calls.map(([event]) => event)).toEqual([
      {
        stage: "registry-received",
        key: a,
        seq: 1,
        status: "active",
        lastAppliedSeq: 0,
      },
      {
        stage: "surface-rendered",
        key: a,
        seq: 1,
        metrics: { bufferLineCount: 1, baseY: 0, viewportY: 0, rows: 30 },
      },
      {
        stage: "registry-result",
        key: a,
        seq: 1,
        result: "applied",
        lastAppliedSeq: 1,
      },
    ]);
  });

  it("reports degraded replay only when its Run becomes selected", () => {
    const factory = new FakeFactory();
    const onDiagnostic = vi.fn();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize: vi.fn(),
      onSnapshotRequest: vi.fn(),
      onDiagnostic,
    });
    const a = key("session-a", "run-a");
    const b = key("session-b", "run-b");
    registry.select(b, true);
    registry.open(open(b));
    registry.open({
      type: "terminal.run.open",
      ...a,
      status: "ended",
      initial: {
        kind: "replay",
        data: "partial",
        firstSeq: 4,
        lastSeq: 4,
        truncatedBytes: 32,
      },
    });

    expect(onDiagnostic).not.toHaveBeenCalledWith(
      "terminal-run-replay-truncated",
      a,
      expect.any(Number),
    );
    registry.select(a, false);
    expect(onDiagnostic).toHaveBeenCalledWith("terminal-run-replay-truncated", a, 4);
  });
  it("evicts old terminal surfaces exactly once while protecting the selected one", () => {
    let now = 0;
    const factory = new FakeFactory();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: vi.fn(),
      onResize: vi.fn(),
      onSnapshotRequest: vi.fn(),
      maxTerminalSurfaces: 1,
      now: () => (now += 1),
    });
    const selected = key("session-a", "selected");
    const old = key("session-b", "old");
    registry.open(open(selected, "ended"));
    registry.select(selected, false);
    registry.open(open(old, "ended"));

    expect(factory.get(old).disposeCount).toBe(1);
    expect(factory.get(selected).disposeCount).toBe(0);
    registry.dispose();
    expect(factory.get(selected).disposeCount).toBe(1);
    expect(factory.get(old).disposeCount).toBe(1);
  });
});
