import { createHash, randomUUID } from "node:crypto";

import {
  ArtifactRefSchema,
  ContentDigestSchema,
  RunIdSchema,
  type AgentInputEnvelopeV1,
  type AgentResponseEnvelopeV1,
  type ArtifactRef,
  type OrchestrationEventV1,
  type StepId,
} from "@honeybee/orchestration-contracts";
import { describe, expect, it } from "vitest";

import { HoneyBeeCoreError } from "./errors.js";
import { OrchestrationWorkflow } from "./orchestration-workflow.js";
import type {
  AgentProcessRequest,
  AgentProcessResult,
  AgentProcessRunner,
  ArtifactGetRequest,
  ArtifactPutRequest,
  ArtifactStore,
  OrchestrationJournal,
} from "./types.js";

const contentDigest = (value: string) =>
  ContentDigestSchema.parse(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);

class MemoryArtifactStore implements ArtifactStore {
  readonly values = new Map<string, string>();
  readonly puts: Array<Readonly<{ request: ArtifactPutRequest; artifact: ArtifactRef }>> = [];
  readonly gets: ArtifactGetRequest[] = [];

  public async put(request: ArtifactPutRequest): Promise<ArtifactRef> {
    const artifact = ArtifactRefSchema.parse({
      artifactId: request.artifactId,
      kind: request.kind,
      mediaType: request.mediaType,
      byteLength: Buffer.byteLength(request.content, "utf8"),
      contentDigest: contentDigest(request.content),
    });
    this.values.set(artifact.artifactId, request.content);
    this.puts.push({ request, artifact });
    return artifact;
  }

  public async get(request: ArtifactGetRequest): Promise<string> {
    this.gets.push(request);
    const value = this.values.get(request.artifact.artifactId);
    if (value === undefined) {
      throw new HoneyBeeCoreError("artifact.read-failed", "missing");
    }
    return value;
  }
}

class RecordingJournal implements OrchestrationJournal {
  readonly events: OrchestrationEventV1[] = [];

  public async append(
    _runId: Parameters<OrchestrationJournal["append"]>[0],
    event: OrchestrationEventV1,
  ) {
    this.events.push(event);
  }

  public async replay(): Promise<never> {
    throw new Error("not used");
  }
}

type Behavior =
  | Readonly<{ kind: "response"; response: Omit<AgentResponseEnvelopeV1, "runId" | "stepId"> }>
  | Readonly<{ kind: "protocol-error" }>
  | Readonly<{ kind: "non-zero" }>;

class RecordingRunner implements AgentProcessRunner {
  readonly requests: AgentProcessRequest[] = [];
  readonly inputs: AgentInputEnvelopeV1[] = [];

  public constructor(private readonly behaviors: Readonly<Record<string, Behavior>> = {}) {}

  public async run(
    request: AgentProcessRequest,
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    this.requests.push(request);
    const serialized = request.prompt.match(
      /HONEYBEE_INPUT_BEGIN\n([\s\S]*?)\nHONEYBEE_INPUT_END/u,
    )?.[1];
    if (serialized === undefined) throw new Error("missing input");
    this.inputs.push(JSON.parse(serialized) as AgentInputEnvelopeV1);
    const pid = 100 + this.requests.length;
    await lifecycle.onStarted(pid);
    const behavior = this.behaviors[request.stepId] ?? {
      kind: "response",
      response: {
        schemaVersion: 1,
        status: "completed",
        content: `output-${request.stepId}`,
      },
    };
    let stdout: string;
    let exitCode = 0;
    let stderr = "";
    if (behavior.kind === "protocol-error") {
      stdout = "not a contract";
    } else if (behavior.kind === "non-zero") {
      stdout = "";
      stderr = "SECRET STDERR";
      exitCode = 7;
    } else {
      stdout = `HONEYBEE_RESPONSE_BEGIN\n${JSON.stringify({
        ...behavior.response,
        runId: request.runId,
        stepId: request.stepId,
      })}\nHONEYBEE_RESPONSE_END`;
    }
    const observation = {
      pid,
      exitCode,
      signal: null,
      durationMs: 2,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutDigest: contentDigest(stdout),
      stderrDigest: contentDigest(stderr),
    } as const;
    await lifecycle.onExited(observation);
    return {
      ...observation,
      stepId: request.stepId,
      command: request.command.command,
      termination: "exited",
      stdout,
      stderr,
    };
  }
}

const steps = (...ids: string[]) =>
  ids.map((id) => ({ id: id as StepId, agent: { command: `agent-${id}` } }));

describe("OrchestrationWorkflow", () => {
  it("runs a strict three-step chain and persists the exact serialized Agent inputs", async () => {
    const runId = RunIdSchema.parse(randomUUID());
    const artifacts = new MemoryArtifactStore();
    const journal = new RecordingJournal();
    const runner = new RecordingRunner();
    const result = await new OrchestrationWorkflow(runner, artifacts, journal).run({
      runId,
      task: "count bees",
      steps: steps("produce", "review", "finalize"),
    });

    expect(result.status).toBe("completed");
    expect(runner.requests).toHaveLength(3);
    expect(runner.inputs[0]?.previous).toBeNull();
    expect(runner.inputs[1]?.previous?.content).toBe("output-produce");
    expect(runner.inputs[2]?.previous?.content).toBe("output-review");
    expect(artifacts.gets.filter((request) => request.artifact.kind === "task")).toHaveLength(3);
    expect(
      artifacts.gets.filter((request) => request.artifact.kind === "step-content"),
    ).toHaveLength(2);

    const inputPuts = artifacts.puts.filter(({ request }) => request.kind === "step-input");
    expect(inputPuts).toHaveLength(3);
    for (const [index, stored] of inputPuts.entries()) {
      const promptInput = runner.requests[index]?.prompt.match(
        /HONEYBEE_INPUT_BEGIN\n([\s\S]*?)\nHONEYBEE_INPUT_END/u,
      )?.[1];
      expect(stored?.request.content).toBe(promptInput);
    }
    expect(journal.events.at(-1)?.type).toBe("workflow.completed");
    expect(journal.events.map((event) => event.sequence)).toEqual(
      journal.events.map((_, index) => index + 1),
    );
  });

  it.each([
    ["blocked", { schemaVersion: 1, status: "blocked", reason: "dependency missing" }],
    [
      "escalated",
      {
        schemaVersion: 1,
        status: "escalated",
        reason: "choice required",
        question: "Which option?",
      },
    ],
  ] as const)(
    "treats exit zero plus %s as a semantic terminal outcome",
    async (status, response) => {
      const runId = RunIdSchema.parse(randomUUID());
      const artifacts = new MemoryArtifactStore();
      const journal = new RecordingJournal();
      const runner = new RecordingRunner({ first: { kind: "response", response } });
      const result = await new OrchestrationWorkflow(runner, artifacts, journal).run({
        runId,
        task: "task",
        steps: steps("first", "second"),
      });

      expect(result.status).toBe(status);
      expect(runner.requests).toHaveLength(1);
      const types = journal.events.map((event) => event.type);
      expect(types.indexOf("agent.exited")).toBeLessThan(types.indexOf(`step.${status}` as never));
      expect(types.at(-1)).toBe(`workflow.${status}`);
    },
  );

  it.each([
    [
      "protocol",
      new RecordingRunner({ first: { kind: "protocol-error" } }),
      "protocol.invalid-agent-response",
    ],
    ["process", new RecordingRunner({ first: { kind: "non-zero" } }), "agent.non-zero-exit"],
  ] as const)(
    "fails closed on %s failure without leaking process text",
    async (_name, runner, code) => {
      const runId = RunIdSchema.parse(randomUUID());
      const journal = new RecordingJournal();
      await expect(
        new OrchestrationWorkflow(runner, new MemoryArtifactStore(), journal).run({
          runId,
          task: "task",
          steps: steps("first", "second"),
        }),
      ).rejects.toMatchObject({ code });

      expect(runner.requests).toHaveLength(1);
      expect(journal.events.at(-1)?.type).toBe("workflow.failed");
      expect(JSON.stringify(journal.events)).not.toContain("SECRET STDERR");
      expect(journal.events.find((event) => event.type === "step.failed")?.payload).toMatchObject({
        errorCode: code,
      });
    },
  );
});
