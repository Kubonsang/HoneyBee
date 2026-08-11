import { createHash, randomUUID } from "node:crypto";

import {
  AgentIdSchema,
  AgentInputEnvelopeV2Schema,
  ArtifactIdSchema,
  ArtifactRefSchema,
  ContentDigestSchema,
  EventIdSchema,
  HarnessIdSchema,
  RunIdSchema,
  StepIdSchema,
  TERMINAL_WORKFLOW_EVENT_V2_TYPES,
  WorkflowConfigV3Schema,
  type AnyOrchestrationEvent,
  type ArtifactRef,
  type ControlRequest,
  type OrchestrationEventV2,
  type RunId,
  type WorkflowConfigV3,
} from "@honeybee/orchestration-contracts";
import { describe, expect, it, vi } from "vitest";

import { DagOrchestrationWorkflow } from "./dag-workflow.js";
import type {
  AgentProcessRequest,
  AgentProcessResult,
  AgentProcessRunner,
  ArtifactGetRequest,
  ArtifactPutRequest,
  ArtifactStore,
  RunControlPort,
  VersionedOrchestrationJournal,
} from "./types.js";

const digest = (value: string) =>
  ContentDigestSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);

class MemoryArtifacts implements ArtifactStore {
  readonly values = new Map<string, string>();
  public async put(request: ArtifactPutRequest): Promise<ArtifactRef> {
    const artifact = ArtifactRefSchema.parse({
      artifactId: request.artifactId,
      kind: request.kind,
      mediaType: request.mediaType,
      byteLength: Buffer.byteLength(request.content),
      contentDigest: digest(request.content),
    });
    this.values.set(artifact.artifactId, request.content);
    return artifact;
  }
  public async get(request: ArtifactGetRequest): Promise<string> {
    const value = this.values.get(request.artifact.artifactId);
    if (value === undefined) throw new Error("missing Artifact");
    return value;
  }
}

class MemoryJournal implements VersionedOrchestrationJournal {
  readonly events: OrchestrationEventV2[] = [];
  public async append(_runId: RunId, event: AnyOrchestrationEvent): Promise<void> {
    if (event.schemaVersion !== 2) throw new Error("v2 only");
    this.events.push(event);
  }
  public async replay(_runId: RunId) {
    const terminal = [...this.events]
      .reverse()
      .find((event) => TERMINAL_WORKFLOW_EVENT_V2_TYPES.has(event.type as never));
    return terminal === undefined
      ? ({ status: "active", events: this.events } as const)
      : ({ status: "terminal", events: this.events, terminal: terminal as never } as const);
  }
}

class MemoryControls implements RunControlPort {
  readonly requests: ControlRequest[] = [];
  public async submit(request: ControlRequest): Promise<void> {
    this.requests.push(request);
  }
  public async pending(_runId: RunId): Promise<readonly ControlRequest[]> {
    return [...this.requests];
  }
  public async acknowledge(request: ControlRequest): Promise<void> {
    const index = this.requests.findIndex((candidate) => candidate.requestId === request.requestId);
    if (index >= 0) this.requests.splice(index, 1);
  }
  public async executorPresent(_runId: RunId): Promise<boolean> {
    return false;
  }
}

interface RunnerOptions {
  readonly delayMs?: number;
  readonly failOnce?: ReadonlySet<string>;
  readonly jsonSteps?: ReadonlySet<string>;
}

class DagRunner implements AgentProcessRunner {
  readonly inputs = new Map<string, ReturnType<typeof AgentInputEnvelopeV2Schema.parse>>();
  readonly attempts = new Map<string, number>();
  readonly timeouts = new Map<string, number>();
  active = 0;
  maxActive = 0;

  public constructor(private readonly options: RunnerOptions = {}) {}

  public async run(
    request: AgentProcessRequest,
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    const serialized = request.prompt.match(
      /HONEYBEE_INPUT_BEGIN\n([\s\S]*?)\nHONEYBEE_INPUT_END/u,
    )?.[1];
    if (serialized === undefined) throw new Error("missing envelope");
    const input = AgentInputEnvelopeV2Schema.parse(JSON.parse(serialized) as unknown);
    this.timeouts.set(request.stepId, request.timeoutMs);
    this.inputs.set(request.stepId, input);
    const attempt = (this.attempts.get(request.stepId) ?? 0) + 1;
    this.attempts.set(request.stepId, attempt);
    const pid = 1_000 + this.attempts.size * 10 + attempt;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await lifecycle.onStarted(pid);
    const termination = await Promise.race([
      new Promise<"exited">((resolve) =>
        setTimeout(() => resolve("exited"), this.options.delayMs ?? 5),
      ),
      new Promise<"cancelled">((resolve) =>
        request.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true }),
      ),
    ]);
    const fails =
      termination === "exited" &&
      this.options.failOnce?.has(request.stepId) === true &&
      attempt === 1;
    const output =
      this.options.jsonSteps?.has(request.stepId) === true
        ? JSON.stringify({ accepted: true, step: request.stepId })
        : `${request.stepId}:${Object.values(input.inputs)
            .map((value) => value.content)
            .join("+")}`;
    const stdout =
      fails || termination === "cancelled"
        ? ""
        : `HONEYBEE_RESPONSE_BEGIN\n${JSON.stringify({
            schemaVersion: 2,
            runId: request.runId,
            stepId: request.stepId,
            status: "completed",
            outputs: {
              content: {
                mediaType:
                  this.options.jsonSteps?.has(request.stepId) === true
                    ? "application/json"
                    : "text/plain; charset=utf-8",
                content: output,
              },
            },
          })}\nHONEYBEE_RESPONSE_END`;
    const observation = {
      pid,
      exitCode: fails ? 7 : termination === "cancelled" ? null : 0,
      signal: termination === "cancelled" ? ("SIGTERM" as const) : null,
      durationMs: this.options.delayMs ?? 5,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      stdoutDigest: digest(stdout),
      stderrDigest: digest(""),
    };
    await lifecycle.onExited(observation);
    this.active -= 1;
    return {
      ...observation,
      stepId: request.stepId,
      command: request.command.command,
      termination,
      stdout,
      stderr: "",
    };
  }
}

const agent = (id: string) => ({ id: AgentIdSchema.parse(id), command: id });
const harnessId = HarnessIdSchema.parse("stdio");
const textOutput = { content: { mediaType: "text/plain; charset=utf-8" as const } };
const jsonOutput = { content: { mediaType: "application/json" as const } };

const config = (steps: WorkflowConfigV3["steps"], maxParallelism = 2): WorkflowConfigV3 =>
  WorkflowConfigV3Schema.parse({
    schemaVersion: 3,
    agents: steps
      .filter((step) => step.type === "agent")
      .map((step) => step.agentRef)
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => agent(id)),
    harnesses: [{ id: harnessId, kind: "stdio-framed-v2", protocolVersion: 2 }],
    steps,
    maxParallelism,
  });

const agentStep = (id: string, extra: Record<string, unknown> = {}) => ({
  id: StepIdSchema.parse(id),
  type: "agent" as const,
  agentRef: AgentIdSchema.parse(id),
  harnessRef: harnessId,
  outputs: textOutput,
  ...extra,
});

const request = (workflowConfig: WorkflowConfigV3) => ({
  runId: RunIdSchema.parse(randomUUID()),
  task: "task",
  config: workflowConfig,
});

describe("DagOrchestrationWorkflow", () => {
  it("runs parallel fan-out up to the limit and supplies verified fan-in inputs", async () => {
    const runner = new DagRunner({ delayMs: 25 });
    const workflow = new DagOrchestrationWorkflow(
      runner,
      new MemoryArtifacts(),
      new MemoryJournal(),
    );
    const result = await workflow.run(
      request(
        config([
          agentStep("left"),
          agentStep("right"),
          agentStep("join", {
            needs: [StepIdSchema.parse("left"), StepIdSchema.parse("right")],
            inputs: {
              left: { from: { stepId: "left", output: "content" } },
              right: { from: { stepId: "right", output: "content" } },
            },
          }),
        ]),
      ),
    );

    expect(result.status).toBe("completed");
    expect(runner.maxActive).toBe(2);
    expect(Object.keys(runner.inputs.get("join")?.inputs ?? {}).sort()).toEqual(["left", "right"]);
  });

  it("evaluates JSON Artifact conditions and records the unselected branch as skipped", async () => {
    const runner = new DagRunner({ jsonSteps: new Set(["decision"]) });
    const journal = new MemoryJournal();
    const result = await new DagOrchestrationWorkflow(runner, new MemoryArtifacts(), journal).run(
      request(
        config([
          { ...agentStep("decision"), outputs: jsonOutput },
          agentStep("selected", {
            when: {
              artifact: {
                stepId: "decision",
                output: "content",
                pointer: "/accepted",
                op: "eq",
                value: true,
              },
            },
          }),
          agentStep("rejected", {
            when: {
              artifact: {
                stepId: "decision",
                output: "content",
                pointer: "/accepted",
                op: "eq",
                value: false,
              },
            },
          }),
        ]),
      ),
    );

    expect(result.steps.find((step) => step.stepId === "selected")?.state).toBe("completed");
    expect(result.steps.find((step) => step.stepId === "rejected")?.state).toBe("skipped");
    expect(journal.events.some((event) => event.type === "step.skipped")).toBe(true);
  });

  it("retries only an allowlisted failure within the bounded attempt budget", async () => {
    const runner = new DagRunner({ failOnce: new Set(["flaky"]) });
    const journal = new MemoryJournal();
    const result = await new DagOrchestrationWorkflow(runner, new MemoryArtifacts(), journal).run(
      request(
        config([
          agentStep("flaky", {
            retry: {
              maxAttempts: 2,
              retryOn: { exitCodes: [7] },
              backoff: { initialDelayMs: 0, maxDelayMs: 0 },
            },
          }),
        ]),
      ),
    );

    expect(result.status).toBe("completed");
    expect(runner.attempts.get("flaky")).toBe(2);
    expect(journal.events.some((event) => event.type === "retry.scheduled")).toBe(true);
  });

  it("skips failed descendants while allowing an independent branch to finish", async () => {
    const runner = new DagRunner({ failOnce: new Set(["broken"]) });
    const result = await new DagOrchestrationWorkflow(
      runner,
      new MemoryArtifacts(),
      new MemoryJournal(),
    ).run(
      request(
        config([
          agentStep("broken"),
          agentStep("child", { needs: [StepIdSchema.parse("broken")] }),
          agentStep("independent"),
        ]),
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.steps.find((step) => step.stepId === "child")?.state).toBe("skipped");
    expect(result.steps.find((step) => step.stepId === "independent")?.state).toBe("completed");
  });

  it("waits at an approval gate and branches on its durable decision Artifact", async () => {
    const controls = new MemoryControls();
    const journal = new MemoryJournal();
    const run = request(
      config([
        {
          id: StepIdSchema.parse("gate"),
          type: "approval",
          outputs: { decision: { mediaType: "application/json" } },
        },
        agentStep("approved", {
          when: {
            artifact: {
              stepId: "gate",
              output: "decision",
              pointer: "/decision",
              op: "eq",
              value: "approved",
            },
          },
        }),
        agentStep("rejected", {
          when: {
            artifact: {
              stepId: "gate",
              output: "decision",
              pointer: "/decision",
              op: "eq",
              value: "rejected",
            },
          },
        }),
      ]),
    );
    const promise = new DagOrchestrationWorkflow(
      new DagRunner(),
      new MemoryArtifacts(),
      journal,
      controls,
    ).run(run);
    await vi.waitFor(() =>
      expect(journal.events.some((event) => event.type === "step.approval-requested")).toBe(true),
    );
    await controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: run.runId,
      action: "approve",
      stepId: StepIdSchema.parse("gate"),
      timestamp: new Date().toISOString(),
    });
    const result = await promise;

    expect(result.steps.find((step) => step.stepId === "approved")?.state).toBe("completed");
    expect(result.steps.find((step) => step.stepId === "rejected")?.state).toBe("skipped");
  });

  it("pauses before scheduling and resumes completed state from the Journal", async () => {
    const controls = new MemoryControls();
    const journal = new MemoryJournal();
    const artifacts = new MemoryArtifacts();
    const runner = new DagRunner();
    const run = request(config([agentStep("only")], 1));
    await controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: run.runId,
      action: "pause",
      timestamp: new Date().toISOString(),
    });
    const workflow = new DagOrchestrationWorkflow(runner, artifacts, journal, controls);
    expect((await workflow.run(run)).status).toBe("paused");
    expect(runner.attempts.size).toBe(0);

    const resumed = await workflow.resume(run.runId);
    expect(resumed.status).toBe("completed");
    expect(runner.attempts.get("only")).toBe(1);
  });

  it("cancels an in-flight Agent and does not schedule pending work", async () => {
    const controls = new MemoryControls();
    const journal = new MemoryJournal();
    const runner = new DagRunner({ delayMs: 5_000 });
    const run = request(
      config(
        [agentStep("running"), agentStep("later", { needs: [StepIdSchema.parse("running")] })],
        1,
      ),
    );
    const promise = new DagOrchestrationWorkflow(
      runner,
      new MemoryArtifacts(),
      journal,
      controls,
    ).run(run);
    await vi.waitFor(() =>
      expect(journal.events.some((event) => event.type === "agent.started")).toBe(true),
    );
    await controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: run.runId,
      action: "cancel",
      timestamp: new Date().toISOString(),
    });
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(result.steps.find((step) => step.stepId === "later")?.state).toBe("skipped");
    expect(journal.events.at(-1)?.type).toBe("workflow.cancelled");
  });

  it("honors a per-step timeout override and restores an uncertain attempt as interrupted", async () => {
    const artifacts = new MemoryArtifacts();
    const journal = new MemoryJournal();
    const runner = new DagRunner();
    const run = request(
      config(
        [
          agentStep("only", {
            timeoutMs: 321,
            retry: { maxAttempts: 2, retryOn: { errorCodes: ["agent.interrupted"] } },
          }),
        ],
        1,
      ),
    );
    const workflow = new DagOrchestrationWorkflow(runner, artifacts, journal);
    expect((await workflow.run(run)).status).toBe("completed");
    expect(runner.timeouts.get("only")).toBe(321);

    const interruptedRunId = RunIdSchema.parse(randomUUID());
    const interruptedConfig = config(
      [
        agentStep("uncertain", {
          retry: { maxAttempts: 2, retryOn: { errorCodes: ["agent.interrupted"] } },
        }),
      ],
      1,
    );
    const configArtifact = await artifacts.put({
      runId: interruptedRunId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: JSON.stringify(interruptedConfig),
    });
    const taskArtifact = await artifacts.put({
      runId: interruptedRunId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const inputArtifact = await artifacts.put({
      runId: interruptedRunId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "step-input",
      mediaType: "application/json",
      content: "{}",
    });
    const emit = async (
      sequence: number,
      type: OrchestrationEventV2["type"],
      payload: unknown,
      stepId?: string,
    ) =>
      journal.append(interruptedRunId, {
        schemaVersion: 2,
        eventId: EventIdSchema.parse(randomUUID()),
        runId: interruptedRunId,
        sequence,
        timestamp: new Date().toISOString(),
        type,
        ...(stepId === undefined ? {} : { stepId: StepIdSchema.parse(stepId) }),
        payload,
      } as OrchestrationEventV2);
    journal.events.splice(0);
    await emit(1, "workflow.started", {
      stepCount: 1,
      maxParallelism: 1,
      config: configArtifact,
      task: taskArtifact,
    });
    await emit(2, "artifact.stored", { artifact: configArtifact });
    await emit(3, "artifact.stored", { artifact: taskArtifact });
    await emit(4, "artifact.stored", { artifact: inputArtifact }, "uncertain");
    await emit(
      5,
      "step.attempt.started",
      { attempt: 1, agentId: "uncertain", harnessId: "stdio", input: inputArtifact },
      "uncertain",
    );
    await emit(
      6,
      "step.assigned",
      { attempt: 1, agentId: "uncertain", harnessId: "stdio" },
      "uncertain",
    );
    await emit(7, "agent.started", { attempt: 1, pid: 999 }, "uncertain");

    const interrupted = await workflow.resume(interruptedRunId);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.steps[0]?.state).toBe("interrupted");
    expect(journal.events.at(-1)?.type).toBe("step.attempt.interrupted");
  });
});
