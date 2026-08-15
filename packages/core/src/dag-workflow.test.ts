import { createHash, randomUUID } from "node:crypto";

import {
  AgentIdSchema,
  AgentInputEnvelopeV2Schema,
  ArtifactIdSchema,
  ArtifactRefSchema,
  ContentDigestSchema,
  EventIdSchema,
  HarnessIdSchema,
  PortNameSchema,
  RunIdSchema,
  StepIdSchema,
  TERMINAL_WORKFLOW_EVENT_V2_TYPES,
  WorkflowConfigV3Schema,
  type AnyOrchestrationEvent,
  type ArtifactRef,
  type ControlRequest,
  type OrchestrationEventV2,
  type RunId,
  type StepId,
  type WorkflowConfigV3,
} from "@honeybee/orchestration-contracts";
import { describe, expect, it, vi } from "vitest";

import { DagOrchestrationWorkflow } from "./dag-workflow.js";
import { HoneyBeeCoreError } from "./errors.js";
import type {
  AgentProcessRequest,
  AgentProcessResult,
  AgentProcessRunner,
  ArtifactGetRequest,
  ArtifactPutRequest,
  ArtifactPutBytesRequest,
  ArtifactStore,
  RunControlPort,
  VersionedOrchestrationJournal,
} from "./types.js";

const digest = (value: string) =>
  ContentDigestSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);

class MemoryArtifacts implements ArtifactStore {
  readonly values = new Map<string, Uint8Array>();
  public async put(request: ArtifactPutRequest): Promise<ArtifactRef> {
    return this.putBytes({ ...request, content: Buffer.from(request.content, "utf8") });
  }
  public async putBytes(request: ArtifactPutBytesRequest): Promise<ArtifactRef> {
    const content = Buffer.from(request.content);
    const artifact = ArtifactRefSchema.parse({
      artifactId: request.artifactId,
      kind: request.kind,
      mediaType: request.mediaType,
      byteLength: content.byteLength,
      contentDigest: ContentDigestSchema.parse(
        `sha256:${createHash("sha256").update(content).digest("hex")}`,
      ),
    });
    this.values.set(artifact.artifactId, content);
    return artifact;
  }
  public async get(request: ArtifactGetRequest): Promise<string> {
    return Buffer.from(await this.getBytes(request)).toString("utf8");
  }
  public async getBytes(request: ArtifactGetRequest): Promise<Uint8Array> {
    const value = this.values.get(request.artifact.artifactId);
    if (value === undefined) throw new Error("missing Artifact");
    return value;
  }
}

class InterruptingArtifacts extends MemoryArtifacts {
  public override async put(request: ArtifactPutRequest): Promise<ArtifactRef> {
    if (request.kind === "step-output" && request.content.startsWith("interrupt:")) {
      throw new HoneyBeeCoreError("artifact.write-failed", "simulated output persistence failure");
    }
    return super.put(request);
  }
}

class BlockingTaskArtifacts extends MemoryArtifacts {
  readonly entered: Promise<void>;
  #release: () => void = () => undefined;
  #markEntered: () => void = () => undefined;
  #blocking = true;

  public constructor() {
    super();
    this.entered = new Promise((resolve) => (this.#markEntered = resolve));
  }

  public release(): void {
    this.#release();
  }

  public override async get(request: ArtifactGetRequest): Promise<string> {
    if (request.artifact.kind === "task" && this.#blocking) {
      this.#blocking = false;
      this.#markEntered();
      await new Promise<void>((resolve) => (this.#release = resolve));
    }
    return super.get(request);
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

class FailingCompletionJournal extends MemoryJournal {
  public override async append(runId: RunId, event: AnyOrchestrationEvent): Promise<void> {
    if (event.schemaVersion === 2 && event.type === "step.completed" && event.stepId === "left") {
      throw new HoneyBeeCoreError("journal.write-failed", "Simulated Journal failure.");
    }
    await super.append(runId, event);
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
  readonly delayByStep?: ReadonlyMap<string, number>;
  readonly failOnce?: ReadonlySet<string>;
  readonly jsonSteps?: ReadonlySet<string>;
  readonly jsonByStep?: ReadonlyMap<string, unknown>;
  readonly escalateSteps?: ReadonlySet<string>;
}

class DagRunner implements AgentProcessRunner {
  readonly inputs = new Map<string, ReturnType<typeof AgentInputEnvelopeV2Schema.parse>>();
  readonly attempts = new Map<string, number>();
  readonly timeouts = new Map<string, number>();
  readonly cancelled = new Set<string>();
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
        setTimeout(
          () => resolve("exited"),
          this.options.delayByStep?.get(request.stepId) ?? this.options.delayMs ?? 5,
        ),
      ),
      new Promise<"cancelled">((resolve) =>
        request.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true }),
      ),
    ]);
    const fails =
      termination === "exited" &&
      this.options.failOnce?.has(request.stepId) === true &&
      attempt === 1;
    const jsonValue = this.options.jsonByStep?.get(request.stepId);
    const output = this.options.jsonByStep?.has(request.stepId)
      ? JSON.stringify(jsonValue)
      : this.options.jsonSteps?.has(request.stepId) === true
        ? JSON.stringify({ accepted: true, step: request.stepId })
        : `${request.stepId}:${Object.values(input.inputs)
            .map((value) => value.content)
            .join("+")}`;
    const response =
      this.options.escalateSteps?.has(request.stepId) === true
        ? {
            schemaVersion: 2,
            runId: request.runId,
            stepId: request.stepId,
            status: "escalated",
            reason: "human decision required",
            question: "Should this continue?",
          }
        : {
            schemaVersion: 2,
            runId: request.runId,
            stepId: request.stepId,
            status: "completed",
            outputs: Object.fromEntries(
              Object.entries(input.outputs).map(([name, declaration]) => [
                name,
                { mediaType: declaration.mediaType, content: output },
              ]),
            ),
          };
    const stdout =
      fails || termination === "cancelled"
        ? ""
        : `HONEYBEE_RESPONSE_BEGIN\n${JSON.stringify(response)}\nHONEYBEE_RESPONSE_END`;
    const observation = {
      pid,
      exitCode: fails ? 7 : termination === "cancelled" ? null : 0,
      signal: termination === "cancelled" ? ("SIGTERM" as const) : null,
      durationMs: this.options.delayByStep?.get(request.stepId) ?? this.options.delayMs ?? 5,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      stdoutDigest: digest(stdout),
      stderrDigest: digest(""),
    };
    if (termination === "cancelled") this.cancelled.add(request.stepId);
    try {
      await lifecycle.onExited(observation);
      return {
        ...observation,
        stepId: request.stepId,
        command: request.command.command,
        termination,
        stdout,
        stderr: "",
      };
    } finally {
      this.active -= 1;
    }
  }
}

const agent = (id: string) => ({ id: AgentIdSchema.parse(id), command: id });
const harnessId = HarnessIdSchema.parse("stdio");
const textOutput = { content: { mediaType: "text/plain; charset=utf-8" as const } };
const jsonOutput = { content: { mediaType: "application/json" as const } };

const config = (
  steps: WorkflowConfigV3["steps"],
  maxParallelism = 2,
  outputs?: WorkflowConfigV3["outputs"],
): WorkflowConfigV3 =>
  WorkflowConfigV3Schema.parse({
    schemaVersion: 3,
    agents: steps
      .filter((step) => step.type === "agent")
      .map((step) => step.agentRef)
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => agent(id)),
    harnesses: [{ id: harnessId, kind: "stdio-framed-v2", protocolVersion: 2 }],
    steps,
    ...(outputs === undefined ? {} : { outputs }),
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

const seedActiveRun = async (
  artifacts: MemoryArtifacts,
  journal: MemoryJournal,
  workflowConfig: WorkflowConfigV3,
) => {
  const runId = RunIdSchema.parse(randomUUID());
  const configArtifact = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "workflow-config",
    mediaType: "application/json",
    content: JSON.stringify(workflowConfig),
  });
  const taskArtifact = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "task",
    mediaType: "text/plain; charset=utf-8",
    content: "task",
  });
  let sequence = 0;
  const emit = async (type: OrchestrationEventV2["type"], payload: unknown, stepId?: StepId) =>
    journal.append(runId, {
      schemaVersion: 2,
      eventId: EventIdSchema.parse(randomUUID()),
      runId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      type,
      ...(stepId === undefined ? {} : { stepId }),
      payload,
    } as OrchestrationEventV2);
  await emit("workflow.started", {
    stepCount: workflowConfig.steps.length,
    maxParallelism: workflowConfig.maxParallelism ?? 1,
    config: configArtifact,
    task: taskArtifact,
  });
  await emit("artifact.stored", { artifact: configArtifact });
  await emit("artifact.stored", { artifact: taskArtifact });
  return { runId, emit };
};

const seedRunningControlCheckpoint = async (
  artifacts: MemoryArtifacts,
  journal: MemoryJournal,
  workflowConfig: WorkflowConfigV3,
  action: "pause" | "cancel",
): Promise<RunId> => {
  const runId = RunIdSchema.parse(randomUUID());
  const step = workflowConfig.steps.find((candidate) => candidate.type === "agent");
  if (step === undefined || step.type !== "agent") throw new Error("Agent step required");
  const configArtifact = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "workflow-config",
    mediaType: "application/json",
    content: JSON.stringify(workflowConfig),
  });
  const taskArtifact = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "task",
    mediaType: "text/plain; charset=utf-8",
    content: "task",
  });
  const inputArtifact = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "step-input",
    mediaType: "application/json",
    content: "{}",
  });
  const requestId = EventIdSchema.parse(randomUUID());
  const emit = async (
    sequence: number,
    type: OrchestrationEventV2["type"],
    payload: unknown,
    stepId?: StepId,
  ) =>
    journal.append(runId, {
      schemaVersion: 2,
      eventId: EventIdSchema.parse(randomUUID()),
      runId,
      sequence,
      timestamp: new Date().toISOString(),
      type,
      ...(stepId === undefined ? {} : { stepId }),
      payload,
    } as OrchestrationEventV2);
  await emit(1, "workflow.started", {
    stepCount: workflowConfig.steps.length,
    maxParallelism: workflowConfig.maxParallelism ?? 1,
    config: configArtifact,
    task: taskArtifact,
  });
  await emit(2, "artifact.stored", { artifact: configArtifact });
  await emit(3, "artifact.stored", { artifact: taskArtifact });
  await emit(4, "artifact.stored", { artifact: inputArtifact }, step.id);
  await emit(
    5,
    "step.attempt.started",
    { attempt: 1, agentId: step.agentRef, harnessId: step.harnessRef, input: inputArtifact },
    step.id,
  );
  await emit(
    6,
    "step.assigned",
    { attempt: 1, agentId: step.agentRef, harnessId: step.harnessRef },
    step.id,
  );
  await emit(7, "agent.started", { attempt: 1, pid: 999 }, step.id);
  await emit(8, "control.accepted", { requestId, action });
  await emit(9, action === "pause" ? "workflow.pausing" : "workflow.cancelling", { requestId });
  return runId;
};

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

  it("serializes the exact named output contract into every v2 Agent input", async () => {
    const runner = new DagRunner();
    const result = await new DagOrchestrationWorkflow(
      runner,
      new MemoryArtifacts(),
      new MemoryJournal(),
    ).run(
      request(
        config([
          agentStep("multi", {
            outputs: {
              summary: { mediaType: "text/plain; charset=utf-8" },
              report: { mediaType: "text/plain; charset=utf-8" },
            },
          }),
        ]),
      ),
    );

    expect(runner.inputs.get("multi")?.outputs).toEqual({
      summary: { mediaType: "text/plain; charset=utf-8" },
      report: { mediaType: "text/plain; charset=utf-8" },
    });
    expect(Object.keys(result.steps[0]?.outputs ?? {}).sort()).toEqual(["report", "summary"]);
  });

  it("evaluates JSON Artifact conditions and records the unselected branch as skipped", async () => {
    const runner = new DagRunner({
      jsonByStep: new Map([
        ["decision", { accepted: true, choices: ["a", "b"], step: "decision" }],
      ]),
    });
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
          agentStep("prototype", {
            when: {
              artifact: {
                stepId: "decision",
                output: "content",
                pointer: "/toString",
                op: "exists",
              },
            },
          }),
          agentStep("array-equal", {
            when: {
              artifact: {
                stepId: "decision",
                output: "content",
                pointer: "/choices",
                op: "eq",
                value: ["a", "b"],
              },
            },
          }),
          agentStep("array-not-equal", {
            when: {
              artifact: {
                stepId: "decision",
                output: "content",
                pointer: "/choices",
                op: "ne",
                value: ["a", "b"],
              },
            },
          }),
        ]),
      ),
    );

    expect(result.steps.find((step) => step.stepId === "selected")?.state).toBe("completed");
    expect(result.steps.find((step) => step.stepId === "rejected")?.state).toBe("skipped");
    expect(result.steps.find((step) => step.stepId === "prototype")?.state).toBe("skipped");
    expect(result.steps.find((step) => step.stepId === "array-equal")?.state).toBe("completed");
    expect(result.steps.find((step) => step.stepId === "array-not-equal")?.state).toBe("skipped");
    expect(journal.events.some((event) => event.type === "step.skipped")).toBe(true);
  });

  it("returns convenience content only from an explicit workflow result output", async () => {
    const withoutBinding = await new DagOrchestrationWorkflow(
      new DagRunner(),
      new MemoryArtifacts(),
      new MemoryJournal(),
    ).run(request(config([agentStep("left"), agentStep("right")])));
    expect(withoutBinding.result).toBeUndefined();

    const withBinding = await new DagOrchestrationWorkflow(
      new DagRunner(),
      new MemoryArtifacts(),
      new MemoryJournal(),
    ).run(
      request(
        config([agentStep("right"), agentStep("left")], 2, {
          [PortNameSchema.parse("result")]: {
            from: {
              stepId: StepIdSchema.parse("right"),
              output: PortNameSchema.parse("content"),
            },
          },
        }),
      ),
    );
    expect(withBinding.result).toBe("right:");
  });

  it("keeps escalation as a semantic outcome without failure metadata", async () => {
    const journal = new MemoryJournal();
    const result = await new DagOrchestrationWorkflow(
      new DagRunner({ escalateSteps: new Set(["review"]) }),
      new MemoryArtifacts(),
      journal,
    ).run(request(config([agentStep("review")])));

    expect(result.status).toBe("escalated");
    expect(result.failure).toBeUndefined();
    expect(journal.events.at(-1)?.type).toBe("workflow.escalated");
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

  it("restores accepted pausing and cancelling checkpoints after an executor crash", async () => {
    const pauseArtifacts = new MemoryArtifacts();
    const pauseJournal = new MemoryJournal();
    const pauseRunner = new DagRunner();
    const pauseRunId = await seedRunningControlCheckpoint(
      pauseArtifacts,
      pauseJournal,
      config([agentStep("paused-step")], 1),
      "pause",
    );
    const pauseWorkflow = new DagOrchestrationWorkflow(pauseRunner, pauseArtifacts, pauseJournal);
    const resumedPause = await pauseWorkflow.resume(pauseRunId);
    expect(resumedPause.status).toBe("paused");
    expect(resumedPause.steps[0]?.state).toBe("interrupted");
    expect(pauseRunner.attempts.size).toBe(0);

    const cancelArtifacts = new MemoryArtifacts();
    const cancelJournal = new MemoryJournal();
    const cancelRunner = new DagRunner();
    const cancelRunId = await seedRunningControlCheckpoint(
      cancelArtifacts,
      cancelJournal,
      config([agentStep("cancelled-step")], 1),
      "cancel",
    );
    const cancelWorkflow = new DagOrchestrationWorkflow(
      cancelRunner,
      cancelArtifacts,
      cancelJournal,
    );
    const resumedCancellation = await cancelWorkflow.resume(cancelRunId);
    expect(resumedCancellation.status).toBe("cancelled");
    expect(resumedCancellation.steps[0]?.state).toBe("cancelled");
    expect(cancelRunner.attempts.size).toBe(0);
  });

  it.each(["pause", "cancel"] as const)(
    "reapplies an accepted %s request when its effect event was not persisted",
    async (action) => {
      const artifacts = new MemoryArtifacts();
      const journal = new MemoryJournal();
      const runner = new DagRunner();
      const workflowConfig = config([agentStep("only")], 1);
      const { runId, emit } = await seedActiveRun(artifacts, journal, workflowConfig);
      const requestId = EventIdSchema.parse(randomUUID());
      await emit("control.accepted", { requestId, action });

      const result = await new DagOrchestrationWorkflow(
        runner,
        artifacts,
        journal,
        new MemoryControls(),
      ).resume(runId);

      expect(result.status).toBe(action === "pause" ? "paused" : "cancelled");
      expect(runner.attempts.size).toBe(0);
      expect(
        journal.events.filter(
          (event) =>
            event.type === (action === "pause" ? "workflow.pausing" : "workflow.cancelling"),
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["approve", "reject"] as const)(
    "reapplies an accepted %s decision after a crash before step completion",
    async (action) => {
      const artifacts = new MemoryArtifacts();
      const journal = new MemoryJournal();
      const gateId = StepIdSchema.parse("gate");
      const workflowConfig = config([
        {
          id: gateId,
          type: "approval",
          outputs: { decision: { mediaType: "application/json" } },
        },
      ]);
      const { runId, emit } = await seedActiveRun(artifacts, journal, workflowConfig);
      await emit("step.approval-requested", { inputs: {} }, gateId);
      await emit("workflow.waiting-approval", { stepId: gateId });
      await emit("control.accepted", {
        requestId: EventIdSchema.parse(randomUUID()),
        action,
        stepId: gateId,
      });

      const result = await new DagOrchestrationWorkflow(
        new DagRunner(),
        artifacts,
        journal,
        new MemoryControls(),
      ).resume(runId);
      const decision = result.steps[0]?.outputs[PortNameSchema.parse("decision")];

      expect(result.status).toBe("completed");
      expect(decision).toBeDefined();
      expect(
        JSON.parse(
          await artifacts.get({
            runId,
            artifact: ArtifactRefSchema.parse(decision),
          }),
        ),
      ).toEqual({ decision: action === "approve" ? "approved" : "rejected" });
    },
  );

  it.each(["retry", "fail"] as const)(
    "reapplies an accepted interrupted-attempt %s and preserves its outcome",
    async (action) => {
      const artifacts = new MemoryArtifacts();
      const journal = new MemoryJournal();
      const runner = new DagRunner();
      const step = agentStep("uncertain", {
        retry: { maxAttempts: 2, retryOn: { errorCodes: ["agent.interrupted"] } },
      });
      const workflowConfig = config([step], 1);
      const { runId, emit } = await seedActiveRun(artifacts, journal, workflowConfig);
      const input = await artifacts.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind: "step-input",
        mediaType: "application/json",
        content: "{}",
      });
      await emit("artifact.stored", { artifact: input }, step.id);
      await emit(
        "step.attempt.started",
        { attempt: 1, agentId: step.agentRef, harnessId: step.harnessRef, input },
        step.id,
      );
      await emit(
        "step.assigned",
        { attempt: 1, agentId: step.agentRef, harnessId: step.harnessRef },
        step.id,
      );
      await emit("agent.started", { attempt: 1, pid: 999 }, step.id);
      await emit("step.attempt.interrupted", { attempt: 1 }, step.id);
      await emit("control.accepted", {
        requestId: EventIdSchema.parse(randomUUID()),
        action,
        stepId: step.id,
      });

      const result = await new DagOrchestrationWorkflow(
        runner,
        artifacts,
        journal,
        new MemoryControls(),
      ).resume(runId);

      expect(result.status).toBe(action === "retry" ? "completed" : "failed");
      expect(runner.attempts.size).toBe(action === "retry" ? 1 : 0);
      if (action === "fail") {
        expect(result.failure).toEqual({ errorCode: "agent.interrupted" });
        expect(journal.events.at(-1)).toMatchObject({
          type: "workflow.failed",
          payload: { errorCode: "agent.interrupted" },
        });
      }
    },
  );

  it("coalesces repeated pause requests and ignores pause after cancellation", async () => {
    const pauseControls = new MemoryControls();
    const pauseJournal = new MemoryJournal();
    const pauseRun = request(config([agentStep("only")], 1));
    for (let index = 0; index < 2; index += 1) {
      await pauseControls.submit({
        requestId: EventIdSchema.parse(randomUUID()),
        runId: pauseRun.runId,
        action: "pause",
        timestamp: new Date().toISOString(),
      });
    }
    const paused = await new DagOrchestrationWorkflow(
      new DagRunner(),
      new MemoryArtifacts(),
      pauseJournal,
      pauseControls,
    ).run(pauseRun);
    expect(paused.status).toBe("paused");
    expect(pauseJournal.events.filter((event) => event.type === "workflow.pausing")).toHaveLength(
      1,
    );
    expect(pauseControls.requests).toHaveLength(0);

    const cancelControls = new MemoryControls();
    const cancelJournal = new MemoryJournal();
    const cancelRun = request(config([agentStep("only")], 1));
    await cancelControls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: cancelRun.runId,
      action: "cancel",
      timestamp: new Date().toISOString(),
    });
    await cancelControls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: cancelRun.runId,
      action: "pause",
      timestamp: new Date().toISOString(),
    });
    const cancelled = await new DagOrchestrationWorkflow(
      new DagRunner(),
      new MemoryArtifacts(),
      cancelJournal,
      cancelControls,
    ).run(cancelRun);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelJournal.events.some((event) => event.type === "workflow.pausing")).toBe(false);
    expect(cancelControls.requests).toHaveLength(0);
  });

  it("drains active siblings before returning an interrupted Run", async () => {
    const runner = new DagRunner({
      delayByStep: new Map([
        ["interrupt", 5],
        ["sibling", 150],
      ]),
    });
    const journal = new MemoryJournal();
    const result = await new DagOrchestrationWorkflow(
      runner,
      new InterruptingArtifacts(),
      journal,
    ).run(request(config([agentStep("interrupt"), agentStep("sibling")], 2)));

    expect(result.status).toBe("interrupted");
    expect(runner.active).toBe(0);
    expect(result.steps.find((step) => step.stepId === "sibling")?.state).toBe("completed");
    const eventCount = journal.events.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(journal.events).toHaveLength(eventCount);
  });

  it("aborts and drains active siblings before propagating a fatal executor error", async () => {
    const runner = new DagRunner({
      delayByStep: new Map([
        ["left", 5],
        ["right", 500],
      ]),
    });
    const workflow = new DagOrchestrationWorkflow(
      runner,
      new MemoryArtifacts(),
      new FailingCompletionJournal(),
    );

    await expect(
      workflow.run(request(config([agentStep("left"), agentStep("right")], 2))),
    ).rejects.toMatchObject({ code: "journal.write-failed" });
    expect(runner.active).toBe(0);
    expect(runner.cancelled).toContain("right");
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

  it("registers cancellation before asynchronous Agent setup and never spawns afterward", async () => {
    const controls = new MemoryControls();
    const journal = new MemoryJournal();
    const runner = new DagRunner();
    const artifacts = new BlockingTaskArtifacts();
    const run = request(config([agentStep("setup")], 1));
    const promise = new DagOrchestrationWorkflow(runner, artifacts, journal, controls).run(run);
    await artifacts.entered;
    await controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: run.runId,
      action: "cancel",
      timestamp: new Date().toISOString(),
    });
    await vi.waitFor(() =>
      expect(journal.events.some((event) => event.type === "workflow.cancelling")).toBe(true),
    );
    artifacts.release();
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(runner.attempts.size).toBe(0);
    expect(journal.events.some((event) => event.type === "agent.started")).toBe(false);
    expect(result.steps[0]?.state).toBe("skipped");
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
