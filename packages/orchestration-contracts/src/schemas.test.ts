import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentInputEnvelopeV1Schema,
  AgentInputEnvelopeV2Schema,
  AgentResponseEnvelopeV1Schema,
  ArtifactRefSchema,
  RunIdSchema,
  StepIdSchema,
  WorkflowConfigV2Schema,
  WorkflowConfigV3Schema,
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

    expect(
      AgentInputEnvelopeV2Schema.safeParse({
        schemaVersion: 2,
        runId,
        step: { id: "review", attempt: 1 },
        task: { artifact: artifact("task"), content: "task" },
        inputs: {},
        outputs: {
          summary: { mediaType: "text/plain; charset=utf-8" },
          report: { mediaType: "application/json" },
        },
      }).success,
    ).toBe(true);
    expect(
      AgentInputEnvelopeV2Schema.safeParse({
        schemaVersion: 2,
        runId,
        step: { id: "review", attempt: 1 },
        task: { artifact: artifact("task"), content: "task" },
        inputs: {},
        outputs: {},
      }).success,
    ).toBe(false);
  });

  it("limits protocol v1 harnesses to the legacy content contract", () => {
    const legacy = {
      schemaVersion: 3,
      agents: [{ id: "worker", command: "worker" }],
      harnesses: [{ id: "legacy", kind: "stdio-framed-v1", protocolVersion: 1 }],
      steps: [
        {
          id: "worker",
          type: "agent",
          agentRef: "worker",
          harnessRef: "legacy",
          outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
        },
      ],
    } as const;
    expect(WorkflowConfigV3Schema.safeParse(legacy).success).toBe(true);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...legacy,
        steps: [
          {
            ...legacy.steps[0],
            outputs: { report: { mediaType: "application/json" } },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...legacy,
        agents: [
          { id: "source", command: "source" },
          { id: "worker", command: "worker" },
        ],
        harnesses: [
          { id: "modern", kind: "stdio-framed-v2", protocolVersion: 2 },
          ...legacy.harnesses,
        ],
        steps: [
          {
            id: "source",
            type: "agent",
            agentRef: "source",
            harnessRef: "modern",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
          {
            ...legacy.steps[0],
            inputs: { previous: { from: { stepId: "source", output: "content" } } },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("strictly validates v3 graph references, cycles, and JSON conditions", () => {
    const base = {
      schemaVersion: 3,
      agents: [
        { id: "source", command: "source" },
        { id: "next", command: "next" },
      ],
      harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
      steps: [
        {
          id: "source",
          type: "agent",
          agentRef: "source",
          harnessRef: "stdio",
          outputs: { decision: { mediaType: "application/json" } },
        },
        {
          id: "next",
          type: "agent",
          agentRef: "next",
          harnessRef: "stdio",
          inputs: { source: { from: { stepId: "source", output: "decision" } } },
          when: {
            artifact: {
              stepId: "source",
              output: "decision",
              pointer: "/accepted",
              op: "eq",
              value: true,
            },
          },
          outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
        },
      ],
    } as const;
    expect(WorkflowConfigV3Schema.safeParse(base).success).toBe(true);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        outputs: { result: { from: { stepId: "next", output: "content" } } },
      }).success,
    ).toBe(true);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        outputs: { result: { from: { stepId: "missing", output: "content" } } },
      }).success,
    ).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        outputs: { result: { from: { stepId: "next", output: "missing" } } },
      }).success,
    ).toBe(false);
    expect(WorkflowConfigV3Schema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        steps: [
          { ...base.steps[0], needs: ["next"] },
          { ...base.steps[1], needs: ["source"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        steps: [
          { ...base.steps[0], outputs: { decision: { mediaType: "text/plain; charset=utf-8" } } },
          base.steps[1],
        ],
      }).success,
    ).toBe(false);
  });
});
