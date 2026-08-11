import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentInputEnvelopeV1Schema,
  AgentResponseEnvelopeV1Schema,
  ArtifactRefSchema,
  RunIdSchema,
  StepIdSchema,
  WorkflowConfigV2Schema,
} from "./schemas.js";

const artifact = (kind: "task" | "step-content") =>
  ArtifactRefSchema.parse({
    artifactId: randomUUID(),
    kind,
    mediaType: "text/plain; charset=utf-8",
    byteLength: 4,
    contentDigest: `sha256:${"a".repeat(64)}`,
  });

describe("orchestration contracts", () => {
  it("brands UUID run IDs and strictly validates step IDs", () => {
    expect(RunIdSchema.safeParse(randomUUID()).success).toBe(true);
    expect(RunIdSchema.safeParse("../escape").success).toBe(false);
    expect(StepIdSchema.safeParse("review_step-1").success).toBe(true);
    expect(StepIdSchema.safeParse("Review").success).toBe(false);
    expect(StepIdSchema.safeParse(`a${"b".repeat(64)}`).success).toBe(false);
  });

  it("rejects duplicate workflow step IDs", () => {
    expect(
      WorkflowConfigV2Schema.safeParse({
        schemaVersion: 2,
        steps: [
          { id: "worker", agent: { command: "a" } },
          { id: "worker", agent: { command: "b" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates correlated Agent input and response envelopes", () => {
    const runId = RunIdSchema.parse(randomUUID());
    const input = AgentInputEnvelopeV1Schema.parse({
      schemaVersion: 1,
      runId,
      step: { id: "review", index: 1, total: 2 },
      task: { artifact: artifact("task"), content: "task" },
      previous: { stepId: "produce", artifact: artifact("step-content"), content: "work" },
    });
    expect(input.step.id).toBe("review");
    expect(
      AgentResponseEnvelopeV1Schema.safeParse({
        schemaVersion: 1,
        runId,
        stepId: "review",
        status: "blocked",
        reason: "needs input",
      }).success,
    ).toBe(true);
  });
});
