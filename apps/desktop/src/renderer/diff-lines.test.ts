import { describe, expect, it } from "vitest";
import { RunSummaryV1Schema } from "@honeybee/control-plane-contracts";

import { buildLineDiff } from "./diff-lines.js";
import { runStage, runTitle } from "./workspace-model.js";

describe("state-driven workspace projections", () => {
  it("projects durable phases onto the four visible stages", () => {
    const summary = (phase: string, terminal = false) =>
      RunSummaryV1Schema.parse({
        schemaVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        mode: "unity-editor-work",
        status: terminal ? "completed" : "running",
        phase,
        terminal,
        executorPresent: !terminal,
        allowedActions: [],
      });
    expect(runStage(summary("agent.running"))).toBe(1);
    expect(runStage(summary("warm-test.running"))).toBe(2);
    expect(runStage(summary("workflow.completed", true))).toBe(3);
    expect(
      runTitle(
        RunSummaryV1Schema.parse({
          ...summary("agent.running"),
          workId: "fix-player-jitter",
        }),
      ),
    ).toBe("Fix Player Jitter");
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
