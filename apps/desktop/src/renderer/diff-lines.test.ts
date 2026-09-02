import { describe, expect, it } from "vitest";
import { RunSummaryV1Schema } from "@honeybee/control-plane-contracts";

import { buildLineDiff } from "./diff-lines.js";
import {
  capabilityToggleDisabled,
  runNeedsAttention,
  runStage,
  runTitle,
} from "./workspace-model.js";

const summary = (phase: string, status = "running", terminal = false) =>
  RunSummaryV1Schema.parse({
    schemaVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    mode: "unity-editor-work",
    status,
    phase,
    terminal,
    executorPresent: !terminal,
    allowedActions: [],
  });

describe("state-driven workspace projections", () => {
  it("projects durable phases onto the four visible stages", () => {
    expect(runStage(summary("agent.running"))).toBe(1);
    expect(runStage(summary("warm-test.running"))).toBe(2);
    expect(runStage(summary("workflow.completed", "completed", true))).toBe(3);
    expect(runStage(summary("workflow.cancelled", "cancelled", true))).toBeLessThan(3);
    expect(runStage(summary("compile.failed", "failed", true))).toBe(2);
    expect(
      runTitle(
        RunSummaryV1Schema.parse({
          ...summary("agent.running"),
          workId: "fix-player-jitter",
        }),
      ),
    ).toBe("Fix Player Jitter");
  });

  it("treats cancelled Runs as attention states instead of successes", () => {
    expect(runNeedsAttention(summary("workflow.cancelled", "cancelled", true))).toBe(true);
    expect(runNeedsAttention(summary("workflow.completed", "completed", true))).toBe(false);
  });

  it("allows unsupported cloned capabilities to be switched off", () => {
    expect(capabilityToggleDisabled(false, true)).toBe(false);
    expect(capabilityToggleDisabled(false, false)).toBe(true);
    expect(capabilityToggleDisabled(true, false)).toBe(false);
  });

  it("produces stable context, removal, and addition lines", () => {
    expect(buildLineDiff("one\ntwo\nthree", "one\ntwo changed\nthree")).toEqual([
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "remove", text: "two", oldLine: 2 },
      { kind: "add", text: "two changed", newLine: 2 },
      { kind: "context", text: "three", oldLine: 3, newLine: 3 },
    ]);
  });
});
