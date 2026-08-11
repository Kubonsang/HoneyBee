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

const NamedIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

export const AgentIdSchema = NamedIdSchema.brand<"AgentId">();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const HarnessIdSchema = NamedIdSchema.brand<"HarnessId">();
export type HarnessId = z.infer<typeof HarnessIdSchema>;

export const PortNameSchema = NamedIdSchema.brand<"PortName">();
export type PortName = z.infer<typeof PortNameSchema>;

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
  "workflow-config",
  "task",
  "step-input",
  "step-content",
  "step-output",
  "approval-decision",
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

const uniqueIds = <T extends { id: string }>(
  values: readonly T[],
  context: z.RefinementCtx,
  path: string,
): void => {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        path: [path, index, "id"],
        message: `Duplicate ${path.slice(0, -1)} id: ${value.id}`,
      });
    }
    seen.add(value.id);
  }
};

export const AgentDefinitionSchema = AgentCommandSchema.extend({ id: AgentIdSchema }).strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const HarnessDefinitionSchema = z
  .object({
    id: HarnessIdSchema,
    kind: z.literal("stdio-framed-v2"),
    protocolVersion: z.literal(2),
  })
  .strict();
export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;

export const ArtifactBindingSchema = z
  .object({
    from: z.object({ stepId: StepIdSchema, output: PortNameSchema }).strict(),
    required: z.boolean().optional(),
  })
  .strict();
export type ArtifactBinding = z.infer<typeof ArtifactBindingSchema>;

export const OutputDeclarationSchema = z.object({ mediaType: ArtifactMediaTypeSchema }).strict();
export type OutputDeclaration = z.infer<typeof OutputDeclarationSchema>;

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof JsonScalarSchema>;

export const StepSemanticOutcomeSchema = z.enum([
  "completed",
  "skipped",
  "failed",
  "blocked",
  "escalated",
  "cancelled",
]);
export type StepSemanticOutcome = z.infer<typeof StepSemanticOutcomeSchema>;

export type ConditionExpression =
  | { readonly all: readonly ConditionExpression[] }
  | { readonly any: readonly ConditionExpression[] }
  | { readonly not: ConditionExpression }
  | {
      readonly stepOutcome: {
        readonly stepId: StepId;
        readonly in: readonly StepSemanticOutcome[];
      };
    }
  | {
      readonly artifact: {
        readonly stepId: StepId;
        readonly output: PortName;
        readonly pointer: string;
        readonly op: "exists" | "eq" | "ne" | "in";
        readonly value?: JsonScalar | readonly JsonScalar[] | undefined;
      };
    };

export const ConditionExpressionSchema: z.ZodType<ConditionExpression> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionExpressionSchema).min(1) }).strict(),
    z.object({ any: z.array(ConditionExpressionSchema).min(1) }).strict(),
    z.object({ not: ConditionExpressionSchema }).strict(),
    z
      .object({
        stepOutcome: z
          .object({ stepId: StepIdSchema, in: z.array(StepSemanticOutcomeSchema).min(1) })
          .strict(),
      })
      .strict(),
    z
      .object({
        artifact: z
          .object({
            stepId: StepIdSchema,
            output: PortNameSchema,
            pointer: z.string().refine((value) => value === "" || value.startsWith("/"), {
              message: "JSON Pointer must be empty or start with '/'.",
            }),
            op: z.enum(["exists", "eq", "ne", "in"]),
            value: z.union([JsonScalarSchema, z.array(JsonScalarSchema)]).optional(),
          })
          .strict(),
      })
      .strict(),
  ]),
);

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20),
    retryOn: z
      .object({
        errorCodes: z.array(z.string().min(1)).optional(),
        exitCodes: z.array(z.number().int()).optional(),
        timeout: z.boolean().optional(),
      })
      .strict(),
    backoff: z
      .object({
        initialDelayMs: z.number().int().nonnegative().max(86_400_000),
        maxDelayMs: z.number().int().nonnegative().max(86_400_000),
      })
      .strict()
      .refine((value) => value.maxDelayMs >= value.initialDelayMs, {
        message: "maxDelayMs must be at least initialDelayMs.",
      })
      .optional(),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

const StepBaseShape = {
  id: StepIdSchema,
  needs: z.array(StepIdSchema).optional(),
  inputs: z.record(PortNameSchema, ArtifactBindingSchema).optional(),
  when: ConditionExpressionSchema.optional(),
};

export const AgentWorkflowStepV3Schema = z
  .object({
    ...StepBaseShape,
    type: z.literal("agent"),
    agentRef: AgentIdSchema,
    harnessRef: HarnessIdSchema,
    outputs: z.record(PortNameSchema, OutputDeclarationSchema),
    timeoutMs: z.number().int().positive().optional(),
    retry: RetryPolicySchema.optional(),
  })
  .strict()
  .refine((step) => Object.keys(step.outputs).length > 0, {
    path: ["outputs"],
    message: "Agent steps need at least one declared output.",
  });
export type AgentWorkflowStepV3 = z.infer<typeof AgentWorkflowStepV3Schema>;

export const ApprovalWorkflowStepV3Schema = z
  .object({
    ...StepBaseShape,
    type: z.literal("approval"),
    outputs: z
      .object({ decision: z.object({ mediaType: z.literal("application/json") }).strict() })
      .strict(),
  })
  .strict();
export type ApprovalWorkflowStepV3 = z.infer<typeof ApprovalWorkflowStepV3Schema>;

export const WorkflowStepV3Schema = z.discriminatedUnion("type", [
  AgentWorkflowStepV3Schema,
  ApprovalWorkflowStepV3Schema,
]);
export type WorkflowStepV3 = z.infer<typeof WorkflowStepV3Schema>;

const conditionReferences = (condition: ConditionExpression | undefined): StepId[] => {
  if (condition === undefined) return [];
  if ("all" in condition) return condition.all.flatMap(conditionReferences);
  if ("any" in condition) return condition.any.flatMap(conditionReferences);
  if ("not" in condition) return conditionReferences(condition.not);
  if ("stepOutcome" in condition) return [condition.stepOutcome.stepId];
  return [condition.artifact.stepId];
};

export const WorkflowConfigV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    agents: z.array(AgentDefinitionSchema),
    harnesses: z.array(HarnessDefinitionSchema).min(1),
    steps: z.array(WorkflowStepV3Schema).min(1),
    maxParallelism: z.number().int().min(1).max(64).optional(),
    defaultTimeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    cancelGraceMs: z.number().int().nonnegative().max(60_000).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    uniqueIds(config.agents, context, "agents");
    uniqueIds(config.harnesses, context, "harnesses");
    uniqueIds(config.steps, context, "steps");
    const agents = new Set(config.agents.map((agent) => agent.id));
    const harnesses = new Set(config.harnesses.map((harness) => harness.id));
    const steps = new Map(config.steps.map((step) => [step.id, step]));
    const dependencies = new Map<StepId, Set<StepId>>();
    for (const [index, step] of config.steps.entries()) {
      if (step.type === "agent" && !agents.has(step.agentRef)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "agentRef"],
          message: "Unknown Agent.",
        });
      }
      if (step.type === "agent" && !harnesses.has(step.harnessRef)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "harnessRef"],
          message: "Unknown Harness.",
        });
      }
      const refs = new Set<StepId>([...(step.needs ?? []), ...conditionReferences(step.when)]);
      if (new Set(step.needs ?? []).size !== (step.needs ?? []).length) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "needs"],
          message: "Duplicate dependency.",
        });
      }
      for (const binding of Object.values(step.inputs ?? {})) refs.add(binding.from.stepId);
      if (refs.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index],
          message: "A step cannot depend on itself.",
        });
      }
      dependencies.set(step.id, refs);
      for (const reference of refs) {
        const source = steps.get(reference);
        if (source === undefined) {
          context.addIssue({
            code: "custom",
            path: ["steps", index],
            message: `Unknown step reference: ${reference}`,
          });
          continue;
        }
        for (const [port, binding] of Object.entries(step.inputs ?? {})) {
          if (binding.from.stepId === reference && !(binding.from.output in source.outputs)) {
            context.addIssue({
              code: "custom",
              path: ["steps", index, "inputs", port],
              message: `Unknown output port: ${binding.from.output}`,
            });
          }
        }
      }
      const validateCondition = (condition: ConditionExpression | undefined): void => {
        if (condition === undefined) return;
        if ("all" in condition) return condition.all.forEach(validateCondition);
        if ("any" in condition) return condition.any.forEach(validateCondition);
        if ("not" in condition) return validateCondition(condition.not);
        if ("stepOutcome" in condition) return;
        const source = steps.get(condition.artifact.stepId);
        const output = Object.entries(source?.outputs ?? {}).find(
          ([name]) => name === condition.artifact.output,
        )?.[1];
        if (output === undefined) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "when"],
            message: `Unknown condition output: ${condition.artifact.output}`,
          });
        } else if (output.mediaType !== "application/json") {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "when"],
            message: "Artifact conditions require application/json outputs.",
          });
        }
        if (condition.artifact.op === "in" && !Array.isArray(condition.artifact.value)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "when"],
            message: "The in operator requires an array value.",
          });
        }
        if (
          ["eq", "ne"].includes(condition.artifact.op) &&
          condition.artifact.value === undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "when"],
            message: "Comparison operator requires a value.",
          });
        }
        if (condition.artifact.op === "exists" && condition.artifact.value !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "when"],
            message: "The exists operator does not accept a value.",
          });
        }
      };
      validateCondition(step.when);
    }
    const visiting = new Set<StepId>();
    const visited = new Set<StepId>();
    const visit = (id: StepId): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dependency of dependencies.get(id) ?? []) if (visit(dependency)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const id of steps.keys()) {
      if (visit(id)) {
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: "Workflow graph contains a cycle.",
        });
        break;
      }
    }
  });
export type WorkflowConfigV3 = z.infer<typeof WorkflowConfigV3Schema>;

export const AgentInputEnvelopeV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runId: RunIdSchema,
    step: z.object({ id: StepIdSchema, attempt: z.number().int().positive() }).strict(),
    task: ArtifactValueSchema,
    inputs: z.record(
      PortNameSchema,
      z
        .object({
          sourceStepId: StepIdSchema,
          sourceOutput: PortNameSchema,
          artifact: ArtifactRefSchema,
          content: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.task.artifact.kind !== "task") {
      context.addIssue({
        code: "custom",
        path: ["task", "artifact", "kind"],
        message: "Task input must reference a task Artifact.",
      });
    }
    for (const [port, value] of Object.entries(input.inputs)) {
      if (!["step-output", "approval-decision"].includes(value.artifact.kind)) {
        context.addIssue({
          code: "custom",
          path: ["inputs", port, "artifact", "kind"],
          message: "Named input must reference a v3 step output Artifact.",
        });
      }
    }
  });
export type AgentInputEnvelopeV2 = z.infer<typeof AgentInputEnvelopeV2Schema>;

const AgentResponseV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  runId: RunIdSchema,
  stepId: StepIdSchema,
});

export const AgentResponseEnvelopeV2Schema = z.discriminatedUnion("status", [
  AgentResponseV2BaseSchema.extend({
    status: z.literal("completed"),
    outputs: z.record(
      PortNameSchema,
      z.object({ mediaType: ArtifactMediaTypeSchema, content: z.string() }).strict(),
    ),
  }).strict(),
  AgentResponseV2BaseSchema.extend({
    status: z.literal("blocked"),
    reason: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
  AgentResponseV2BaseSchema.extend({
    status: z.literal("escalated"),
    reason: z.string().refine((value) => value.trim().length > 0),
    question: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
]);
export type AgentResponseEnvelopeV2 = z.infer<typeof AgentResponseEnvelopeV2Schema>;

const ArtifactOutputMapSchema = z.record(PortNameSchema, ArtifactRefSchema);
const WorkflowOutputMapSchema = z.record(StepIdSchema, ArtifactOutputMapSchema);
const AttemptPayloadSchema = z.object({ attempt: z.number().int().positive() }).strict();
const AttemptFailureSchema = FailureMetadataSchema.extend({
  attempt: z.number().int().positive(),
}).strict();

const EventV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: EventIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  stepId: StepIdSchema.optional(),
});
const eventV2 = <Type extends string, Payload extends z.ZodType>(type: Type, payload: Payload) =>
  EventV2BaseSchema.extend({ type: z.literal(type), payload }).strict();

export const ControlActionSchema = z.enum([
  "pause",
  "cancel",
  "approve",
  "reject",
  "retry",
  "fail",
]);
export type ControlAction = z.infer<typeof ControlActionSchema>;
export const ControlRequestSchema = z
  .object({
    requestId: EventIdSchema,
    runId: RunIdSchema,
    action: ControlActionSchema,
    stepId: StepIdSchema.optional(),
    timestamp: z.string().datetime(),
  })
  .strict();
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const OrchestrationEventV2Schema = z
  .discriminatedUnion("type", [
    eventV2(
      "workflow.started",
      z
        .object({
          stepCount: z.number().int().positive(),
          maxParallelism: z.number().int().positive(),
          config: ArtifactRefSchema,
          task: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV2(
      "artifact.stored",
      z.object({ artifact: ArtifactRefSchema, outputPort: PortNameSchema.optional() }).strict(),
    ),
    eventV2(
      "step.attempt.started",
      z
        .object({
          attempt: z.number().int().positive(),
          agentId: AgentIdSchema,
          harnessId: HarnessIdSchema,
          input: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV2(
      "step.assigned",
      z
        .object({
          attempt: z.number().int().positive(),
          agentId: AgentIdSchema,
          harnessId: HarnessIdSchema,
        })
        .strict(),
    ),
    eventV2(
      "agent.started",
      z.object({ attempt: z.number().int().positive(), pid: z.number().int().positive() }).strict(),
    ),
    eventV2(
      "agent.exited",
      ProcessMetadataSchema.extend({ attempt: z.number().int().positive() }).strict(),
    ),
    eventV2("agent.input-write-failed", AttemptFailureSchema),
    eventV2("step.attempt.failed", AttemptFailureSchema),
    eventV2("step.attempt.interrupted", AttemptPayloadSchema),
    eventV2(
      "retry.scheduled",
      z
        .object({
          attempt: z.number().int().positive(),
          errorCode: z.string().min(1),
          notBefore: z.string().datetime(),
        })
        .strict(),
    ),
    eventV2(
      "step.completed",
      z
        .object({ attempt: z.number().int().nonnegative(), outputs: ArtifactOutputMapSchema })
        .strict(),
    ),
    eventV2(
      "step.blocked",
      z.object({ attempt: z.number().int().positive(), reason: ArtifactRefSchema }).strict(),
    ),
    eventV2(
      "step.escalated",
      z
        .object({
          attempt: z.number().int().positive(),
          reason: ArtifactRefSchema,
          question: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV2(
      "step.failed",
      FailureMetadataSchema.extend({ attempt: z.number().int().nonnegative().optional() }).strict(),
    ),
    eventV2(
      "step.skipped",
      z
        .object({
          reason: z.enum(["condition-false", "upstream-unsatisfied", "workflow-cancelled"]),
        })
        .strict(),
    ),
    eventV2("step.cancelled", AttemptPayloadSchema),
    eventV2(
      "step.approval-requested",
      z.object({ inputs: z.record(PortNameSchema, ArtifactRefSchema) }).strict(),
    ),
    eventV2(
      "control.accepted",
      z
        .object({
          requestId: EventIdSchema,
          action: ControlActionSchema,
          stepId: StepIdSchema.optional(),
        })
        .strict(),
    ),
    eventV2("workflow.pausing", z.object({ requestId: EventIdSchema }).strict()),
    eventV2("workflow.paused", z.object({}).strict()),
    eventV2("workflow.resumed", z.object({}).strict()),
    eventV2("workflow.waiting-approval", z.object({ stepId: StepIdSchema }).strict()),
    eventV2("workflow.cancelling", z.object({ requestId: EventIdSchema }).strict()),
    eventV2("workflow.completed", z.object({ outputs: WorkflowOutputMapSchema }).strict()),
    eventV2("workflow.blocked", z.object({}).strict()),
    eventV2("workflow.escalated", z.object({}).strict()),
    eventV2("workflow.failed", FailureMetadataSchema),
    eventV2("workflow.cancelled", z.object({}).strict()),
  ])
  .superRefine((event, context) => {
    const workflowScoped = event.type.startsWith("workflow.") || event.type === "control.accepted";
    const taskArtifact =
      event.type === "artifact.stored" &&
      ["task", "workflow-config"].includes(event.payload.artifact.kind);
    if (!workflowScoped && !taskArtifact && event.stepId === undefined) {
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
export type OrchestrationEventV2 = z.infer<typeof OrchestrationEventV2Schema>;
export type AnyOrchestrationEvent = OrchestrationEventV1 | OrchestrationEventV2;

export type TerminalWorkflowEventV2 = Extract<
  OrchestrationEventV2,
  {
    type:
      | "workflow.completed"
      | "workflow.blocked"
      | "workflow.escalated"
      | "workflow.failed"
      | "workflow.cancelled";
  }
>;
export const TERMINAL_WORKFLOW_EVENT_V2_TYPES = new Set<TerminalWorkflowEventV2["type"]>([
  "workflow.completed",
  "workflow.blocked",
  "workflow.escalated",
  "workflow.failed",
  "workflow.cancelled",
]);
