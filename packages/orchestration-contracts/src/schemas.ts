import { z } from "zod";

export const RunIdSchema = z.string().uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;

export const ArtifactIdSchema = z.string().uuid().brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const EventIdSchema = z.string().uuid().brand<"OrchestrationEventId">();
export type EventId = z.infer<typeof EventIdSchema>;

export const StepIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
  .brand<"StepId">();
export type StepId = z.infer<typeof StepIdSchema>;

export const ContentDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .brand<"ContentDigest">();
export type ContentDigest = z.infer<typeof ContentDigestSchema>;

export const AgentCommandSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const WorkflowStepSchema = z
  .object({ id: StepIdSchema, agent: AgentCommandSchema })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowConfigV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    steps: z.array(WorkflowStepSchema).min(2),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const [index, step] of config.steps.entries()) {
      if (seen.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `Duplicate step id: ${step.id}`,
        });
      }
      seen.add(step.id);
    }
  });
export type WorkflowConfigV2 = z.infer<typeof WorkflowConfigV2Schema>;

export const ArtifactKindSchema = z.enum([
  "task",
  "step-input",
  "step-content",
  "blocked-reason",
  "escalation-reason",
  "escalation-question",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactMediaTypeSchema = z.enum(["text/plain; charset=utf-8", "application/json"]);
export type ArtifactMediaType = z.infer<typeof ArtifactMediaTypeSchema>;

export const ArtifactRefSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    kind: ArtifactKindSchema,
    mediaType: ArtifactMediaTypeSchema,
    byteLength: z.number().int().nonnegative(),
    contentDigest: ContentDigestSchema,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

const ArtifactValueSchema = z.object({ artifact: ArtifactRefSchema, content: z.string() }).strict();

export const AgentInputEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    step: z
      .object({
        id: StepIdSchema,
        index: z.number().int().nonnegative(),
        total: z.number().int().positive(),
      })
      .strict(),
    task: ArtifactValueSchema,
    previous: z
      .object({
        stepId: StepIdSchema,
        artifact: ArtifactRefSchema,
        content: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.step.index >= input.step.total) {
      context.addIssue({
        code: "custom",
        path: ["step", "index"],
        message: "Step index must be less than the total step count.",
      });
    }
    if (input.task.artifact.kind !== "task") {
      context.addIssue({
        code: "custom",
        path: ["task", "artifact", "kind"],
        message: "Task input must reference a task Artifact.",
      });
    }
    if (input.previous !== null && input.previous.artifact.kind !== "step-content") {
      context.addIssue({
        code: "custom",
        path: ["previous", "artifact", "kind"],
        message: "Previous input must reference a step-content Artifact.",
      });
    }
  });
export type AgentInputEnvelopeV1 = z.infer<typeof AgentInputEnvelopeV1Schema>;

const AgentResponseBaseSchema = z.object({
  schemaVersion: z.literal(1),
  runId: RunIdSchema,
  stepId: StepIdSchema,
});

export const AgentResponseEnvelopeV1Schema = z.discriminatedUnion("status", [
  AgentResponseBaseSchema.extend({
    status: z.literal("completed"),
    content: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
  AgentResponseBaseSchema.extend({
    status: z.literal("blocked"),
    reason: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
  AgentResponseBaseSchema.extend({
    status: z.literal("escalated"),
    reason: z.string().refine((value) => value.trim().length > 0),
    question: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
]);
export type AgentResponseEnvelopeV1 = z.infer<typeof AgentResponseEnvelopeV1Schema>;

export const FailureMetadataSchema = z
  .object({
    errorCode: z.string().min(1),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().min(1).nullable().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type FailureMetadata = z.infer<typeof FailureMetadataSchema>;

const EventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: EventIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  stepId: StepIdSchema.optional(),
});

const eventSchema = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) => EventBaseSchema.extend({ type: z.literal(type), payload }).strict();

const ProcessMetadataSchema = z
  .object({
    pid: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).nullable(),
    durationMs: z.number().int().nonnegative(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    stdoutDigest: ContentDigestSchema.optional(),
    stderrDigest: ContentDigestSchema.optional(),
  })
  .strict();

const StepScopedEventTypeSchema = z.enum([
  "step.assigned",
  "agent.started",
  "agent.exited",
  "handoff.created",
  "step.completed",
  "step.blocked",
  "step.escalated",
  "step.failed",
]);

export const OrchestrationEventV1Schema = z
  .discriminatedUnion("type", [
    eventSchema("workflow.started", z.object({ stepCount: z.number().int().min(2) }).strict()),
    eventSchema("artifact.stored", z.object({ artifact: ArtifactRefSchema }).strict()),
    eventSchema(
      "step.assigned",
      z
        .object({ stepIndex: z.number().int().nonnegative(), totalSteps: z.number().int().min(2) })
        .strict(),
    ),
    eventSchema("agent.started", z.object({ pid: z.number().int().positive() }).strict()),
    eventSchema("agent.exited", ProcessMetadataSchema),
    eventSchema(
      "handoff.created",
      z
        .object({ fromStepId: StepIdSchema, toStepId: StepIdSchema, artifact: ArtifactRefSchema })
        .strict(),
    ),
    eventSchema("step.completed", z.object({ output: ArtifactRefSchema }).strict()),
    eventSchema("step.blocked", z.object({ reason: ArtifactRefSchema }).strict()),
    eventSchema(
      "step.escalated",
      z.object({ reason: ArtifactRefSchema, question: ArtifactRefSchema }).strict(),
    ),
    eventSchema("step.failed", FailureMetadataSchema),
    eventSchema("workflow.completed", z.object({ result: ArtifactRefSchema }).strict()),
    eventSchema("workflow.blocked", z.object({ reason: ArtifactRefSchema }).strict()),
    eventSchema(
      "workflow.escalated",
      z.object({ reason: ArtifactRefSchema, question: ArtifactRefSchema }).strict(),
    ),
    eventSchema("workflow.failed", FailureMetadataSchema),
  ])
  .superRefine((event, context) => {
    const stepScoped = StepScopedEventTypeSchema.safeParse(event.type).success;
    const stepArtifact = event.type === "artifact.stored" && event.payload.artifact.kind !== "task";
    if ((stepScoped || stepArtifact) && event.stepId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "Step-scoped event needs stepId.",
      });
    }
    if (event.type.startsWith("workflow.") && event.stepId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "Workflow event cannot have stepId.",
      });
    }
  });
export type OrchestrationEventV1 = z.infer<typeof OrchestrationEventV1Schema>;

export type TerminalWorkflowEvent = Extract<
  OrchestrationEventV1,
  {
    type: "workflow.completed" | "workflow.blocked" | "workflow.escalated" | "workflow.failed";
  }
>;

export const TERMINAL_WORKFLOW_EVENT_TYPES = new Set<TerminalWorkflowEvent["type"]>([
  "workflow.completed",
  "workflow.blocked",
  "workflow.escalated",
  "workflow.failed",
]);
