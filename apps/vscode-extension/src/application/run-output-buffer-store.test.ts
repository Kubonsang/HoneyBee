import { describe, expect, it } from "vitest";

import { RunIdSchema, SessionIdSchema } from "@honeybee/domain";

import { RunOutputBufferStore } from "./run-output-buffer-store.js";

const session = (value: string) => SessionIdSchema.parse(value);
const run = (value: string) => RunIdSchema.parse(value);

describe("RunOutputBufferStore", () => {
  it("isolates different Runs of the same Session and rejects duplicate sequence data", () => {
    const store = new RunOutputBufferStore();
    store.append(session("session-a"), run("run-1"), 1, "one");
    store.append(session("session-a"), run("run-2"), 1, "two");

    expect(store.append(session("session-a"), run("run-1"), 1, "duplicate")).toEqual({
      status: "duplicate",
      lastSeq: 1,
    });
    expect(store.snapshot(session("session-a"), run("run-1"))?.data).toBe("one");
    expect(store.snapshot(session("session-a"), run("run-2"))?.data).toBe("two");
  });

  it("detects sequence gaps and ignores data after a Run is terminal", () => {
    const store = new RunOutputBufferStore();
    expect(store.append(session("session-a"), run("run-1"), 3, "late")).toEqual({
      status: "applied",
      expectedSeq: 1,
      gap: true,
    });
    store.markTerminal(session("session-a"), run("run-1"), 4);
    expect(store.append(session("session-a"), run("run-1"), 5, "ignored")).toEqual({
      status: "terminal",
      finalSeq: 4,
    });
    expect(store.snapshot(session("session-a"), run("run-1"))).toMatchObject({
      data: "late",
      sequenceGap: true,
    });
    expect(store.inspect(session("session-a"), run("run-1"))?.sequenceGap).toBe(true);
  });

  it("bounds each Run by exact UTF-8 bytes and reports truncation", () => {
    const store = new RunOutputBufferStore({ perRunBytes: 4, totalBytes: 100 });
    store.append(session("session-a"), run("run-1"), 1, "A벌B");
    const snapshot = store.snapshot(session("session-a"), run("run-1"));

    expect(snapshot?.data).toBe("벌B");
    expect(Buffer.byteLength(snapshot?.data ?? "", "utf8")).toBe(4);
    expect(snapshot?.truncatedBytes).toBe(1);
  });

  it("evicts old terminal Runs while protecting active and selected Runs", () => {
    let now = 0;
    const store = new RunOutputBufferStore({
      perRunBytes: 16,
      totalBytes: 8,
      maxTerminalRuns: 2,
      now: () => (now += 1),
    });
    store.append(session("session-a"), run("active"), 1, "active");
    store.append(session("session-a"), run("old"), 1, "old");
    store.append(session("session-a"), run("selected"), 1, "selected");
    store.setSelected(run("selected"));
    store.markTerminal(session("session-a"), run("selected"), 2);
    const retention = store.markTerminal(session("session-a"), run("old"), 2);
    expect(retention.evictedRunIds).toContain(run("old"));
    expect(store.has(run("active"))).toBe(true);
    expect(store.has(run("selected"))).toBe(true);
    expect(retention.limitExceeded).toBe(true);
  });

  it("rejects a Run ID reused by another Session", () => {
    const store = new RunOutputBufferStore();
    store.open(session("session-a"), run("run-1"));

    expect(() => store.open(session("session-b"), run("run-1"))).toThrow(
      "already owned by another Session",
    );
  });
});
