import { describe, expect, it } from "vitest";

import { RunIdSchema, StepIdSchema } from "@honeybee/orchestration-contracts";
import type { AgentSessionTraceEvent } from "honeybee-cli/runtime";

import { DesktopTerminalBroker } from "./terminal-broker.js";

const runA = RunIdSchema.parse("11111111-1111-4111-8111-111111111111");
const runB = RunIdSchema.parse("22222222-2222-4222-8222-222222222222");
const step = StepIdSchema.parse("unity-agent");

const trace = (
  runId: typeof runA,
  channel: AgentSessionTraceEvent["channel"],
  mode: AgentSessionTraceEvent["mode"],
  text: string,
): AgentSessionTraceEvent => ({
  runId,
  stepId: step,
  timestamp: new Date(0).toISOString(),
  channel,
  mode,
  text,
});

describe("DesktopTerminalBroker", () => {
  it("coalesces readable deltas and gates Raw entries at the snapshot boundary", () => {
    const broker = new DesktopTerminalBroker();
    broker.onTrace(trace(runA, "assistant", "readable", "hel"));
    broker.onTrace(trace(runA, "assistant", "readable", "lo"));
    broker.onTrace({
      ...trace(runA, "raw", "raw", '{"jsonrpc":"2.0"}'),
      direction: "provider",
    });

    const readable = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "readable",
      state: "running",
      rawEnabled: false,
    });
    expect(readable.entries).toHaveLength(1);
    expect(readable.entries[0]?.text).toBe("hello");
    expect(readable.rawAvailable).toBe(false);

    const hiddenRaw = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "raw",
      state: "running",
      rawEnabled: false,
    });
    expect(hiddenRaw.entries).toEqual([]);

    const raw = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "raw",
      state: "running",
      rawEnabled: true,
    });
    expect(raw.rawAvailable).toBe(true);
    expect(raw.entries).toMatchObject([{ text: '{"jsonrpc":"2.0"}', direction: "provider" }]);
  });

  it("merges child Run streams in cursor order", () => {
    const broker = new DesktopTerminalBroker();
    broker.onTrace(trace(runA, "system", "readable", "parent"));
    broker.onTrace(trace(runB, "tool", "readable", "child"));
    const parentOnly = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "readable",
      state: "running",
      rawEnabled: false,
    });
    const result = broker.snapshot({
      scopeKey: runA,
      runIds: [runA, runB],
      afterCursor: 0,
      mode: "readable",
      state: "running",
      rawEnabled: false,
    });
    expect(result.entries.map((entry) => entry.text)).toEqual(["parent", "child"]);
    expect(result.entries.map((entry) => entry.runId)).toEqual([runA, runB]);
    expect(result.instanceId).not.toBe(parentOnly.instanceId);
  });

  it("enforces per-Run count and entry-size limits", () => {
    const broker = new DesktopTerminalBroker();
    for (let index = 0; index < 5_001; index += 1) {
      broker.onTrace(trace(runA, "system", "readable", String(index)));
    }
    broker.onTrace(trace(runA, "system", "readable", "x".repeat(20_000)));
    const result = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "readable",
      state: "completed",
      rawEnabled: false,
    });
    expect(result.entries).toHaveLength(5_000);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.entries.at(-1)?.text ?? "", "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
  });

  it("reconstructs readable and Raw output once from a durable transcript", () => {
    const broker = new DesktopTerminalBroker();
    const transcript = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: "restored" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/commandExecution/started",
        params: {},
      }),
    ].join("\n");
    broker.replayTranscript(runA, step, transcript, new Date(0).toISOString());
    broker.replayTranscript(runA, step, transcript, new Date(0).toISOString());

    const readable = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "readable",
      state: "completed",
      rawEnabled: true,
    });
    expect(readable.entries.map((entry) => entry.text)).toEqual([
      "Replaying the durable Agent session transcript.",
      "restored",
      "item · commandExecution · started",
    ]);
    const raw = broker.snapshot({
      scopeKey: runA,
      runIds: [runA],
      afterCursor: 0,
      mode: "raw",
      state: "completed",
      rawEnabled: true,
    });
    expect(raw.entries).toHaveLength(2);
  });
});
