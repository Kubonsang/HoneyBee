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

export const ResourceIdSchema = NamedIdSchema.brand<"ResourceId">();
export type ResourceId = z.infer<typeof ResourceIdSchema>;

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

export const UnityAgentConfigSchema = z
  .object({
    command: AgentCommandSchema,
    harness: z.literal("stdio-framed-v2"),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict();
export type UnityAgentConfig = z.infer<typeof UnityAgentConfigSchema>;

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
  "unity-source-manifest",
  "workspace-acquire-request",
  "workspace-acquire-receipt",
  "testplay-evidence",
  "workspace-release-receipt",
  "unity-workspace-manifest",
  "unity-patch-content",
  "unity-verified-patch",
  "editor-launch-intent",
  "editor-containment-receipt",
  "editor-ownership-receipt",
  "warm-bridge-binding",
  "unity-capability-evidence",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactMediaTypeSchema = z.enum([
  "text/plain; charset=utf-8",
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/octet-stream",
  "application/vnd.honeybee.unity-patch+json",
]);
export type ArtifactMediaType = z.infer<typeof ArtifactMediaTypeSchema>;
const AgentArtifactMediaTypeSchema = z.enum(["text/plain; charset=utf-8", "application/json"]);

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

const StdioFramedHarnessV1Schema = z
  .object({
    id: HarnessIdSchema,
    kind: z.literal("stdio-framed-v1"),
    protocolVersion: z.literal(1),
  })
  .strict();

const StdioFramedHarnessV2Schema = z
  .object({
    id: HarnessIdSchema,
    kind: z.literal("stdio-framed-v2"),
    protocolVersion: z.literal(2),
  })
  .strict();

export const HarnessDefinitionSchema = z.discriminatedUnion("protocolVersion", [
  StdioFramedHarnessV1Schema,
  StdioFramedHarnessV2Schema,
]);
export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;

export const ArtifactBindingSchema = z
  .object({
    from: z.object({ stepId: StepIdSchema, output: PortNameSchema }).strict(),
    required: z.boolean().optional(),
  })
  .strict();
export type ArtifactBinding = z.infer<typeof ArtifactBindingSchema>;

export const WorkflowOutputBindingSchema = z
  .object({ from: z.object({ stepId: StepIdSchema, output: PortNameSchema }).strict() })
  .strict();
export type WorkflowOutputBinding = z.infer<typeof WorkflowOutputBindingSchema>;

export const OutputDeclarationSchema = z
  .object({ mediaType: AgentArtifactMediaTypeSchema })
  .strict();
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
    outputs: z.record(PortNameSchema, WorkflowOutputBindingSchema).optional(),
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
    const harnesses = new Map(config.harnesses.map((harness) => [harness.id, harness]));
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
      const harness = step.type === "agent" ? harnesses.get(step.harnessRef) : undefined;
      if (step.type === "agent" && harness === undefined) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "harnessRef"],
          message: "Unknown Harness.",
        });
      }
      if (step.type === "agent" && harness?.protocolVersion === 1) {
        const outputEntries = Object.entries(step.outputs);
        if (
          outputEntries.length !== 1 ||
          outputEntries[0]?.[0] !== "content" ||
          outputEntries[0]?.[1].mediaType !== "text/plain; charset=utf-8"
        ) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "outputs"],
            message: "Protocol v1 Agents require one text/plain content output.",
          });
        }
        const unsupportedInput = Object.keys(step.inputs ?? {}).find((name) => name !== "previous");
        if (unsupportedInput !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "inputs", unsupportedInput],
            message: "Protocol v1 Agents support only the previous input.",
          });
        }
        const previous = step.inputs?.["previous" as PortName];
        const source = previous === undefined ? undefined : steps.get(previous.from.stepId);
        const sourceHarness =
          source?.type === "agent" ? harnesses.get(source.harnessRef) : undefined;
        if (previous !== undefined && sourceHarness?.protocolVersion !== 1) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "inputs", "previous"],
            message: "Protocol v1 previous input must come from a protocol v1 Agent.",
          });
        }
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
          if (
            binding.from.stepId === reference &&
            !Object.hasOwn(source.outputs, binding.from.output)
          ) {
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
    for (const [name, binding] of Object.entries(config.outputs ?? {})) {
      const source = steps.get(binding.from.stepId);
      if (source === undefined) {
        context.addIssue({
          code: "custom",
          path: ["outputs", name],
          message: `Unknown workflow output step: ${binding.from.stepId}`,
        });
      } else if (!Object.hasOwn(source.outputs, binding.from.output)) {
        context.addIssue({
          code: "custom",
          path: ["outputs", name],
          message: `Unknown workflow output port: ${binding.from.output}`,
        });
      }
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

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const UnityLibraryKeySchema = z
  .object({
    schemaVersion: z.literal("1"),
    digest: Sha256HexSchema,
    unityVersion: z.string().min(1),
    unityExecutableSha256: Sha256HexSchema,
    manifestSha256: Sha256HexSchema,
    packagesLockSha256: z.union([Sha256HexSchema, z.literal("missing")]),
    projectSettingsSha256: Sha256HexSchema,
    buildTarget: z.string().min(1),
    scriptingBackend: z.string().min(1),
    projectIdentitySha256: Sha256HexSchema,
  })
  .strict();
export type UnityLibraryKey = z.infer<typeof UnityLibraryKeySchema>;

export const UnityWorkspaceParentKeySchema = z
  .object({
    schemaVersion: z.literal(2),
    digest: Sha256HexSchema,
    libraryKey: UnityLibraryKeySchema,
    provider: z.literal("vhdx-differencing"),
    filesystem: z.literal("NTFS"),
    virtualBytes: z.number().int().positive(),
    blockBytes: z.number().int().positive(),
    sectorBytes: z.number().int().positive(),
    localPackagesDigest: Sha256HexSchema.optional(),
  })
  .strict();
export type UnityWorkspaceParentKey = z.infer<typeof UnityWorkspaceParentKeySchema>;

const WorkspaceStorageCommandSchema = AgentCommandSchema.superRefine((command, context) => {
  if ((command.args?.length ?? 0) > 0) {
    context.addIssue({
      code: "custom",
      path: ["args"],
      message: "Workspace storage must be one pinned executable without arguments.",
    });
  }
  if (command.env !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["env"],
      message: "Workspace storage cannot inject an unpinned execution environment.",
    });
  }
});

export const UnityWorkspaceStorageV1Schema = z
  .object({
    command: WorkspaceStorageCommandSchema,
    contractCommit: z.literal("575c3b37896cd3dfa37a4705477837cc52ec6132"),
    binarySha256: Sha256HexSchema,
    workspaceRoot: z.string().min(1),
    parentKey: UnityWorkspaceParentKeySchema,
    storeMaxAllocatedBytes: z.number().int().positive().optional(),
    minimumHostFreeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type UnityWorkspaceStorageV1 = z.infer<typeof UnityWorkspaceStorageV1Schema>;

export const UnityWorkspaceStorageV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    command: WorkspaceStorageCommandSchema,
    binarySha256: Sha256HexSchema,
    workspaceRoot: z.string().min(1),
    compatibilityKey: Sha256HexSchema,
    parentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    provider: z.string().trim().min(1).max(64),
    storeMaxAllocatedBytes: z.number().int().positive().optional(),
    minimumHostFreeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type UnityWorkspaceStorageV2 = z.infer<typeof UnityWorkspaceStorageV2Schema>;

export const UnityBridgeOverlaySchema = z
  .object({
    packageName: z.literal("com.testplay.bridge"),
    sourcePath: z.string().min(1),
    digest: Sha256HexSchema,
  })
  .strict();
export type UnityBridgeOverlay = z.infer<typeof UnityBridgeOverlaySchema>;

export const UnityWorkConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceProjectPath: z.string().min(1),
    workspaceStorage: UnityWorkspaceStorageV1Schema,
    agent: UnityAgentConfigSchema,
    testplay: z
      .object({
        command: AgentCommandSchema,
        unityPath: z.string().min(1),
        platform: z.enum(["edit_mode", "play_mode"]),
        timeoutMs: z.number().int().positive(),
        filter: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.workspaceStorage.parentKey.localPackagesDigest !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["workspaceStorage", "parentKey", "localPackagesDigest"],
        message: "Unity work v0.4 does not stage external local packages.",
      });
    }
  });
export type UnityWorkConfigV1 = z.infer<typeof UnityWorkConfigV1Schema>;

export const UnityWorkPrioritySchema = z.enum(["interactive", "validation", "background"]);
export type UnityWorkPriority = z.infer<typeof UnityWorkPrioritySchema>;

export const UnityCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ id: StepIdSchema, kind: z.literal("compile") }).strict(),
  z
    .object({
      id: StepIdSchema,
      kind: z.literal("warm-test"),
      filter: z.string().trim().min(1).optional(),
      category: z.string().trim().min(1).optional(),
    })
    .strict(),
]);
export type UnityCapability = z.infer<typeof UnityCapabilitySchema>;

const UnityCapabilityListSchema = z
  .array(UnityCapabilitySchema)
  .max(16)
  .superRefine((capabilities, context) => {
    const ids = new Set<string>();
    for (const [index, capability] of capabilities.entries()) {
      if (ids.has(capability.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Duplicate capability id: ${capability.id}`,
        });
      }
      ids.add(capability.id);
    }
  });

export const UnityEditorPoolConfigSchema = z
  .object({
    id: ResourceIdSchema,
    capacity: z.number().int().min(1).max(32),
    registrationTimeoutMs: z.number().int().positive(),
    activationTimeoutMs: z.number().int().positive(),
    bridgeReadyTimeoutMs: z.number().int().positive(),
    capabilityTimeoutMs: z.number().int().positive(),
    shutdownTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type UnityEditorPoolConfig = z.infer<typeof UnityEditorPoolConfigSchema>;

const UnityWorkConfigV2BaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    sourceProjectPath: z.string().min(1),
    workspaceStorage: z.union([UnityWorkspaceStorageV1Schema, UnityWorkspaceStorageV2Schema]),
    agent: UnityAgentConfigSchema,
    testplay: z
      .object({
        command: AgentCommandSchema,
        unityPath: z.string().min(1),
        platform: z.literal("edit_mode"),
        timeoutMs: z.number().int().positive(),
        bridgeProtocolVersion: z.literal(3),
      })
      .strict()
      .optional(),
    editorPool: UnityEditorPoolConfigSchema,
    priority: UnityWorkPrioritySchema.default("validation"),
    capabilities: UnityCapabilityListSchema,
    bridgeOverlay: UnityBridgeOverlaySchema.optional(),
  })
  .strict();

export const UnityWorkConfigV2Schema = UnityWorkConfigV2BaseSchema.superRefine(
  (config, context) => {
    if (
      !("schemaVersion" in config.workspaceStorage) &&
      config.workspaceStorage.parentKey.localPackagesDigest !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspaceStorage", "parentKey", "localPackagesDigest"],
        message: "Unity work v0.6 does not stage external local packages.",
      });
    }
    if (config.capabilities.length > 0 && config.testplay === undefined) {
      context.addIssue({
        code: "custom",
        path: ["testplay"],
        message: "TestPlay is required when compile or warm-test capabilities are selected.",
      });
    }
  },
);
export type UnityWorkConfigV2 = z.infer<typeof UnityWorkConfigV2Schema>;
export const UnityWorkConfigSchema = z.discriminatedUnion("schemaVersion", [
  UnityWorkConfigV1Schema,
  UnityWorkConfigV2Schema,
]);
export type UnityWorkConfig = z.infer<typeof UnityWorkConfigSchema>;

const UnityBatchResourcesSchema = z
  .array(
    z
      .object({
        id: ResourceIdSchema,
        capacity: z.literal(1),
      })
      .strict(),
  )
  .min(1);
const UnityBatchWorksSchema = z
  .array(
    z
      .object({
        id: StepIdSchema,
        task: z.string().trim().min(1),
        resourceRef: ResourceIdSchema,
      })
      .strict(),
  )
  .min(2);
const validateUnityBatchConfig = (
  config: Readonly<{
    maxParallelWorks: number;
    resources: readonly { id: ResourceId }[];
    works: readonly { id: StepId; resourceRef: ResourceId }[];
  }>,
  context: z.RefinementCtx,
): void => {
  if (config.maxParallelWorks > config.works.length) {
    context.addIssue({
      code: "custom",
      path: ["maxParallelWorks"],
      message: "maxParallelWorks cannot exceed the number of Works.",
    });
  }
  const resources = new Set<string>();
  for (const [index, resource] of config.resources.entries()) {
    if (resources.has(resource.id)) {
      context.addIssue({
        code: "custom",
        path: ["resources", index, "id"],
        message: `Duplicate resource id: ${resource.id}`,
      });
    }
    resources.add(resource.id);
  }
  const works = new Set<string>();
  for (const [index, work] of config.works.entries()) {
    if (works.has(work.id)) {
      context.addIssue({
        code: "custom",
        path: ["works", index, "id"],
        message: `Duplicate Work id: ${work.id}`,
      });
    }
    works.add(work.id);
    if (!resources.has(work.resourceRef)) {
      context.addIssue({
        code: "custom",
        path: ["works", index, "resourceRef"],
        message: `Unknown resource reference: ${work.resourceRef}`,
      });
    }
  }
};

export const UnityBatchConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("unity-batch"),
    maxParallelWorks: z.number().int().positive(),
    transaction: UnityWorkConfigV1Schema,
    resources: UnityBatchResourcesSchema,
    works: UnityBatchWorksSchema,
  })
  .strict()
  .superRefine(validateUnityBatchConfig);
export type UnityBatchConfigV1 = z.infer<typeof UnityBatchConfigV1Schema>;

export const UnityBatchConfigV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    mode: z.literal("unity-batch"),
    resourceScope: z.literal("global-file-v1"),
    maxParallelWorks: z.number().int().positive(),
    transaction: UnityWorkConfigV1Schema,
    resources: UnityBatchResourcesSchema,
    works: UnityBatchWorksSchema,
  })
  .strict()
  .superRefine(validateUnityBatchConfig);
export type UnityBatchConfigV2 = z.infer<typeof UnityBatchConfigV2Schema>;

const UnityBatchWorksV3Schema = z
  .array(
    z
      .object({
        id: StepIdSchema,
        task: z.string().trim().min(1),
        priority: UnityWorkPrioritySchema.default("validation"),
        capabilities: UnityCapabilityListSchema,
      })
      .strict(),
  )
  .min(2);

export const UnityBatchTransactionV3Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceProjectPath: z.string().min(1),
    workspaceStorage: z.union([UnityWorkspaceStorageV1Schema, UnityWorkspaceStorageV2Schema]),
    agent: z
      .object({
        command: AgentCommandSchema,
        harness: z.literal("stdio-framed-v2"),
        timeoutMs: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().optional(),
      })
      .strict(),
    testplay: z
      .object({
        command: AgentCommandSchema,
        unityPath: z.string().min(1),
        platform: z.literal("edit_mode"),
        timeoutMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    bridgeOverlay: UnityBridgeOverlaySchema.optional(),
  })
  .strict();
export type UnityBatchTransactionV3 = z.infer<typeof UnityBatchTransactionV3Schema>;

export const UnityBatchConfigV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    mode: z.literal("unity-batch"),
    resourceScope: z.literal("global-editor-pool-v2"),
    maxParallelWorks: z.number().int().positive(),
    transaction: UnityBatchTransactionV3Schema,
    editorPool: UnityEditorPoolConfigSchema,
    bridgeProtocolVersion: z.literal(3).optional(),
    works: UnityBatchWorksV3Schema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.maxParallelWorks > config.works.length) {
      context.addIssue({
        code: "custom",
        path: ["maxParallelWorks"],
        message: "maxParallelWorks cannot exceed the number of Works.",
      });
    }
    const works = new Set<string>();
    for (const [index, work] of config.works.entries()) {
      if (works.has(work.id)) {
        context.addIssue({
          code: "custom",
          path: ["works", index, "id"],
          message: `Duplicate Work id: ${work.id}`,
        });
      }
      works.add(work.id);
    }
    if ((config.transaction.workspaceStorage.command.args?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "workspaceStorage", "command", "args"],
        message: "Workspace storage must be one pinned executable without arguments.",
      });
    }
    if (config.transaction.workspaceStorage.command.env !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "workspaceStorage", "command", "env"],
        message: "Workspace storage cannot inject an unpinned execution environment.",
      });
    }
    const requiresValidation = config.works.some((work) => work.capabilities.length > 0);
    if (requiresValidation && config.transaction.testplay === undefined) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "testplay"],
        message: "TestPlay is required when compile or warm-test capabilities are selected.",
      });
    }
    if (requiresValidation && config.bridgeProtocolVersion !== 3) {
      context.addIssue({
        code: "custom",
        path: ["bridgeProtocolVersion"],
        message: "TestPlay capabilities require Bridge protocol 3.",
      });
    }
    if (
      config.transaction.testplay !== undefined &&
      config.transaction.testplay.platform !== "edit_mode"
    ) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "testplay", "platform"],
        message: "Unity v0.6 batches require edit-mode TestPlay.",
      });
    }
  });
export type UnityBatchConfigV3 = z.infer<typeof UnityBatchConfigV3Schema>;

const UnityBatchWorksV4Schema = z
  .array(
    z
      .object({
        id: StepIdSchema,
        task: z.string().trim().min(1),
        priority: UnityWorkPrioritySchema.default("validation"),
        capabilities: UnityCapabilityListSchema,
        agent: UnityAgentConfigSchema,
      })
      .strict(),
  )
  .min(2);

export const UnityBatchConfigV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    mode: z.literal("unity-batch"),
    resourceScope: z.literal("global-editor-pool-v2"),
    maxParallelWorks: z.number().int().positive(),
    transaction: UnityBatchTransactionV3Schema,
    editorPool: UnityEditorPoolConfigSchema,
    bridgeProtocolVersion: z.literal(3).optional(),
    works: UnityBatchWorksV4Schema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.maxParallelWorks > config.works.length) {
      context.addIssue({
        code: "custom",
        path: ["maxParallelWorks"],
        message: "maxParallelWorks cannot exceed the number of Works.",
      });
    }
    const works = new Set<string>();
    for (const [index, work] of config.works.entries()) {
      if (works.has(work.id)) {
        context.addIssue({
          code: "custom",
          path: ["works", index, "id"],
          message: `Duplicate Work id: ${work.id}`,
        });
      }
      works.add(work.id);
    }
    if ((config.transaction.workspaceStorage.command.args?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "workspaceStorage", "command", "args"],
        message: "Workspace storage must be one pinned executable without arguments.",
      });
    }
    if (config.transaction.workspaceStorage.command.env !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "workspaceStorage", "command", "env"],
        message: "Workspace storage cannot inject an unpinned execution environment.",
      });
    }
    const requiresValidation = config.works.some((work) => work.capabilities.length > 0);
    if (requiresValidation && config.transaction.testplay === undefined) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "testplay"],
        message: "TestPlay is required when compile or warm-test capabilities are selected.",
      });
    }
    if (requiresValidation && config.bridgeProtocolVersion !== 3) {
      context.addIssue({
        code: "custom",
        path: ["bridgeProtocolVersion"],
        message: "TestPlay capabilities require Bridge protocol 3.",
      });
    }
    if (
      config.transaction.testplay !== undefined &&
      config.transaction.testplay.platform !== "edit_mode"
    ) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "testplay", "platform"],
        message: "Unity v0.6 batches require edit-mode TestPlay.",
      });
    }
  });
export type UnityBatchConfigV4 = z.infer<typeof UnityBatchConfigV4Schema>;

export const UnityBatchConfigSchema = z.discriminatedUnion("schemaVersion", [
  UnityBatchConfigV1Schema,
  UnityBatchConfigV2Schema,
  UnityBatchConfigV3Schema,
  UnityBatchConfigV4Schema,
]);
export type UnityBatchConfig = z.infer<typeof UnityBatchConfigSchema>;

const UnityGlobalResourceEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: EventIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  resourceId: ResourceIdSchema,
  requestId: EventIdSchema,
  ownerRunId: RunIdSchema,
  ticket: z.number().int().positive(),
});
const unityGlobalResourceEvent = <Type extends string, Payload extends z.ZodRawShape>(
  type: Type,
  payload: Payload,
) => UnityGlobalResourceEventBaseSchema.extend({ type: z.literal(type), ...payload }).strict();
export const UnityGlobalResourceEventV1Schema = z.discriminatedUnion("type", [
  unityGlobalResourceEvent("resource.queued", {}),
  unityGlobalResourceEvent("resource.acquired", { leaseId: EventIdSchema }),
  unityGlobalResourceEvent("resource.cancelled", {}),
  unityGlobalResourceEvent("resource.released", { leaseId: EventIdSchema }),
]);
export type UnityGlobalResourceEventV1 = z.infer<typeof UnityGlobalResourceEventV1Schema>;

export const UnityEditorSlotIdSchema = z
  .string()
  .regex(/^editor-[1-9][0-9]*$/u)
  .brand<"UnityEditorSlotId">();
export type UnityEditorSlotId = z.infer<typeof UnityEditorSlotIdSchema>;

const UnityEditorPoolEventV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: EventIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  poolId: ResourceIdSchema,
});
const editorPoolEventV2 = <Type extends string, Payload extends z.ZodRawShape>(
  type: Type,
  payload: Payload,
) => UnityEditorPoolEventV2BaseSchema.extend({ type: z.literal(type), ...payload }).strict();
const EditorPoolRequestFields = {
  requestId: EventIdSchema,
  ownerRunId: RunIdSchema,
  ownerWorkId: StepIdSchema,
  priority: UnityWorkPrioritySchema,
  ticket: z.number().int().positive(),
};
export const UnityEditorPoolEventV2Schema = z.discriminatedUnion("type", [
  editorPoolEventV2("editor-pool.declared", {
    capacity: z.number().int().min(1).max(32),
  }),
  editorPoolEventV2("editor-pool.queued", EditorPoolRequestFields),
  editorPoolEventV2("editor-pool.acquired", {
    ...EditorPoolRequestFields,
    leaseId: EventIdSchema,
    slotId: UnityEditorSlotIdSchema,
  }),
  editorPoolEventV2("editor-pool.cancelled", EditorPoolRequestFields),
  editorPoolEventV2("editor-pool.released", {
    ...EditorPoolRequestFields,
    leaseId: EventIdSchema,
    slotId: UnityEditorSlotIdSchema,
  }),
]);
export type UnityEditorPoolEventV2 = z.infer<typeof UnityEditorPoolEventV2Schema>;

export const UnityEditorOwnershipSchema = z.enum(["honeybee", "user", "unknown"]);
export type UnityEditorOwnership = z.infer<typeof UnityEditorOwnershipSchema>;

export const UnityEditorObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    editorId: EventIdSchema,
    pid: z.number().int().positive(),
    processIdentity: z.string().min(1).max(512),
    executablePath: z.string().min(1).optional(),
    projectPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    ownership: UnityEditorOwnershipSchema,
    ownerRunId: RunIdSchema.optional(),
    ownerWorkId: StepIdSchema.optional(),
    slotId: UnityEditorSlotIdSchema.optional(),
    launchId: EventIdSchema.optional(),
    state: z.enum(["alive", "exited", "stale"]),
    pathObservation: z.enum(["confirmed", "unavailable", "invalid"]),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.ownership === "honeybee" &&
      (observation.ownerRunId === undefined ||
        observation.ownerWorkId === undefined ||
        observation.slotId === undefined ||
        observation.launchId === undefined ||
        observation.projectPath === undefined ||
        observation.workspaceId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "HoneyBee-owned Editor observations need durable owner and workspace identity.",
      });
    }
    if (
      observation.ownership !== "honeybee" &&
      (observation.ownerRunId !== undefined ||
        observation.ownerWorkId !== undefined ||
        observation.slotId !== undefined ||
        observation.launchId !== undefined ||
        observation.workspaceId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "User or unknown Editors cannot carry HoneyBee lease ownership.",
      });
    }
  });
export type UnityEditorObservationV1 = z.infer<typeof UnityEditorObservationV1Schema>;

const LaunchNonceSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const EditorLaunchIntentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: LaunchNonceSchema,
    poolId: ResourceIdSchema,
    slotId: UnityEditorSlotIdSchema,
    poolLeaseId: EventIdSchema,
    ownerRunId: RunIdSchema,
    ownerWorkId: StepIdSchema,
    workspaceId: z.string().min(1),
    projectPath: z.string().min(1),
    unityExecutablePath: z.string().min(1),
    unityExecutableDigest: ContentDigestSchema,
    containmentReceiptPath: z.string().min(1),
    registrationTimeoutMs: z.number().int().positive(),
    activationTimeoutMs: z.number().int().positive(),
    shutdownTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type EditorLaunchIntentV1 = z.infer<typeof EditorLaunchIntentV1Schema>;

export const EditorContainmentReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: LaunchNonceSchema,
    containmentPid: z.number().int().positive(),
    processIdentity: z.string().min(1).max(512),
    containmentProtocol: z.literal("editor-deferred-v1"),
    poolId: ResourceIdSchema,
    slotId: UnityEditorSlotIdSchema,
    poolLeaseId: EventIdSchema,
    workspaceId: z.string().min(1),
    publishedAt: z.string().datetime(),
  })
  .strict();
export type EditorContainmentReceiptV1 = z.infer<typeof EditorContainmentReceiptV1Schema>;

export const EditorOwnershipReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: LaunchNonceSchema,
    editorId: EventIdSchema,
    editorPid: z.number().int().positive(),
    editorProcessIdentity: z.string().min(1).max(512),
    containment: ArtifactRefSchema,
    poolId: ResourceIdSchema,
    slotId: UnityEditorSlotIdSchema,
    poolLeaseId: EventIdSchema,
    ownerRunId: RunIdSchema,
    ownerWorkId: StepIdSchema,
    workspaceId: z.string().min(1),
    projectPath: z.string().min(1),
    unityExecutablePath: z.string().min(1),
    unityExecutableDigest: ContentDigestSchema,
    establishedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.containment.kind !== "editor-containment-receipt") {
      context.addIssue({
        code: "custom",
        path: ["containment", "kind"],
        message: "Editor ownership must reference its containment receipt.",
      });
    }
  });
export type EditorOwnershipReceiptV1 = z.infer<typeof EditorOwnershipReceiptV1Schema>;

export const WarmBridgeBindingV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    editorId: EventIdSchema,
    editorPid: z.number().int().positive(),
    editorProcessIdentity: z.string().min(1).max(512),
    workspaceId: z.string().min(1),
    projectPath: z.string().min(1),
    bridgeSessionId: z.string().min(1).max(256),
    bridgeProtocolVersion: z.literal(3),
    editorState: z.literal("idle"),
    heartbeatAt: z.string().datetime(),
    boundAt: z.string().datetime(),
  })
  .strict();
export type WarmBridgeBindingV1 = z.infer<typeof WarmBridgeBindingV1Schema>;

const UnityPatchContentRefSchema = ArtifactRefSchema.superRefine((artifact, context) => {
  if (artifact.kind !== "unity-patch-content") {
    context.addIssue({ code: "custom", path: ["kind"], message: "Expected patch content." });
  }
  if (artifact.mediaType !== "application/octet-stream") {
    context.addIssue({
      code: "custom",
      path: ["mediaType"],
      message: "Patch content must contain raw bytes.",
    });
  }
});

const unsafeWindowsPathSegment = (segment: string): boolean =>
  /[<>:"|?*]/u.test(segment) ||
  [...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20);

const UnityPatchPathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const segments = value.split("/");
    return (
      !value.includes("\\") &&
      !value.startsWith("/") &&
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !unsafeWindowsPathSegment(segment) &&
          !/[. ]$/u.test(segment) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
      ) &&
      ["Assets", "Packages", "ProjectSettings"].includes(segments[0] ?? "")
    );
  }, "Patch paths must be safe Unity project-relative paths.");

export const UnityPatchManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    baseManifest: ArtifactRefSchema,
    resultManifest: ArtifactRefSchema,
    entries: z.array(
      z.discriminatedUnion("operation", [
        z
          .object({
            path: UnityPatchPathSchema,
            operation: z.literal("add-or-modify"),
            content: UnityPatchContentRefSchema,
          })
          .strict(),
        z
          .object({
            path: UnityPatchPathSchema,
            operation: z.literal("delete"),
            baseContentDigest: ContentDigestSchema,
          })
          .strict(),
      ]),
    ),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.baseManifest.kind !== "unity-source-manifest") {
      context.addIssue({
        code: "custom",
        path: ["baseManifest", "kind"],
        message: "Patch base must be a Unity source manifest.",
      });
    }
    if (manifest.baseManifest.mediaType !== "application/json") {
      context.addIssue({
        code: "custom",
        path: ["baseManifest", "mediaType"],
        message: "Patch base manifest must be JSON.",
      });
    }
    if (manifest.resultManifest.kind !== "unity-workspace-manifest") {
      context.addIssue({
        code: "custom",
        path: ["resultManifest", "kind"],
        message: "Patch result must be a Unity workspace manifest.",
      });
    }
    if (manifest.resultManifest.mediaType !== "application/json") {
      context.addIssue({
        code: "custom",
        path: ["resultManifest", "mediaType"],
        message: "Patch result manifest must be JSON.",
      });
    }
    let previous: string | undefined;
    const caseInsensitive = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (
        previous !== undefined &&
        Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Patch entries must be unique and sorted by UTF-8 path bytes.",
        });
      }
      const folded = entry.path.toLocaleLowerCase("en-US");
      if (caseInsensitive.has(folded)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Patch paths cannot collide case-insensitively.",
        });
      }
      previous = entry.path;
      caseInsensitive.add(folded);
    }
  });
export type UnityPatchManifestV1 = z.infer<typeof UnityPatchManifestV1Schema>;

const OptionalUnityPatchContentRefSchema = UnityPatchContentRefSchema.optional();

export const UnityPatchManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    baseManifest: ArtifactRefSchema,
    baseTreeManifest: ArtifactRefSchema,
    resultManifest: ArtifactRefSchema,
    entries: z.array(
      z.discriminatedUnion("operation", [
        z
          .object({
            path: UnityPatchPathSchema,
            operation: z.literal("add"),
            after: UnityPatchContentRefSchema,
          })
          .strict(),
        z
          .object({
            path: UnityPatchPathSchema,
            operation: z.literal("modify"),
            baseContentDigest: ContentDigestSchema,
            before: OptionalUnityPatchContentRefSchema,
            after: UnityPatchContentRefSchema,
          })
          .strict(),
        z
          .object({
            path: UnityPatchPathSchema,
            operation: z.literal("delete"),
            baseContentDigest: ContentDigestSchema,
            before: OptionalUnityPatchContentRefSchema,
          })
          .strict(),
      ]),
    ),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.baseManifest.kind !== "unity-source-manifest" ||
      manifest.baseManifest.mediaType !== "application/json"
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseManifest"],
        message: "Patch base must be a JSON Unity source manifest.",
      });
    }
    for (const key of ["baseTreeManifest", "resultManifest"] as const) {
      if (
        manifest[key].kind !== "unity-workspace-manifest" ||
        manifest[key].mediaType !== "application/json"
      ) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Patch tree manifests must be JSON Unity workspace manifests.",
        });
      }
    }
    let previous: string | undefined;
    const caseInsensitive = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (
        previous !== undefined &&
        Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Patch entries must be unique and sorted by UTF-8 path bytes.",
        });
      }
      const folded = entry.path.toLocaleLowerCase("en-US");
      if (caseInsensitive.has(folded)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Patch paths cannot collide case-insensitively.",
        });
      }
      if (
        entry.operation !== "add" &&
        entry.before !== undefined &&
        entry.before.contentDigest !== entry.baseContentDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "before", "contentDigest"],
          message: "Before content must match the declared base digest.",
        });
      }
      previous = entry.path;
      caseInsensitive.add(folded);
    }
  });
export type UnityPatchManifestV2 = z.infer<typeof UnityPatchManifestV2Schema>;

export const PatchVerificationV1Schema = z
  .object({
    workspaceIntegrity: z.literal("verified"),
    compile: z.enum(["passed", "not-run"]),
    warmTest: z.enum(["passed", "not-run"]),
  })
  .strict();
export type PatchVerificationV1 = z.infer<typeof PatchVerificationV1Schema>;

export const UnityPatchManifestV3Schema = z
  .object({
    ...UnityPatchManifestV2Schema.shape,
    schemaVersion: z.literal(3),
    verification: PatchVerificationV1Schema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.baseManifest.kind !== "unity-source-manifest" ||
      manifest.baseManifest.mediaType !== "application/json"
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseManifest"],
        message: "Patch base must be a JSON Unity source manifest.",
      });
    }
    for (const key of ["baseTreeManifest", "resultManifest"] as const) {
      if (
        manifest[key].kind !== "unity-workspace-manifest" ||
        manifest[key].mediaType !== "application/json"
      ) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Patch tree manifests must be JSON Unity workspace manifests.",
        });
      }
    }
    let previous: string | undefined;
    const caseInsensitive = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (
        previous !== undefined &&
        Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Patch entries must be unique and sorted by UTF-8 path bytes.",
        });
      }
      const folded = entry.path.toLocaleLowerCase("en-US");
      if (caseInsensitive.has(folded)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Patch paths cannot collide case-insensitively.",
        });
      }
      if (
        entry.operation !== "add" &&
        entry.before !== undefined &&
        entry.before.contentDigest !== entry.baseContentDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "before", "contentDigest"],
          message: "Before content must match the declared base digest.",
        });
      }
      previous = entry.path;
      caseInsensitive.add(folded);
    }
  });
export type UnityPatchManifestV3 = z.infer<typeof UnityPatchManifestV3Schema>;

export const UnityPatchManifestSchema = z.discriminatedUnion("schemaVersion", [
  UnityPatchManifestV1Schema,
  UnityPatchManifestV2Schema,
  UnityPatchManifestV3Schema,
]);
export type UnityPatchManifest = z.infer<typeof UnityPatchManifestSchema>;

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
    outputs: z
      .record(PortNameSchema, OutputDeclarationSchema)
      .refine((value) => Object.keys(value).length > 0, {
        message: "Agent input must declare at least one output.",
      }),
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
      z.object({ mediaType: AgentArtifactMediaTypeSchema, content: z.string() }).strict(),
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

const EventV3BaseSchema = z.object({
  schemaVersion: z.literal(3),
  eventId: EventIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  stepId: StepIdSchema.optional(),
});
const eventV3 = <Type extends string, Payload extends z.ZodType>(type: Type, payload: Payload) =>
  EventV3BaseSchema.extend({ type: z.literal(type), payload }).strict();

const UnityTransactionDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed") }).strict(),
  z.object({ outcome: z.literal("failed"), failure: FailureMetadataSchema }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
]);

export const OrchestrationEventV3Schema = z
  .discriminatedUnion("type", [
    eventV3(
      "workflow.started",
      z
        .object({
          mode: z.literal("unity-work-v1"),
          config: ArtifactRefSchema,
          task: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV3("artifact.stored", z.object({ artifact: ArtifactRefSchema }).strict()),
    eventV3("source.baselined", z.object({ manifest: ArtifactRefSchema }).strict()),
    eventV3(
      "workspace.prepared",
      z.object({ workspaceId: z.string().min(1), sourceManifest: ArtifactRefSchema }).strict(),
    ),
    eventV3(
      "workspace.acquire-started",
      z.object({ request: ArtifactRefSchema, requestId: z.string().min(1) }).strict(),
    ),
    eventV3("workspace.acquire-failed", z.object({ failure: FailureMetadataSchema }).strict()),
    eventV3(
      "workspace.acquired",
      z
        .object({
          workspaceId: z.string().min(1),
          leaseId: z.string().min(1),
          receipt: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV3(
      "agent.started",
      z
        .object({
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512).optional(),
          containment: z.literal("deferred-v1").optional(),
        })
        .strict(),
    ),
    eventV3("agent.exited", ProcessMetadataSchema),
    eventV3("agent.input-write-failed", FailureMetadataSchema),
    eventV3(
      "testplay.started",
      z
        .object({
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512).optional(),
          containment: z.literal("deferred-v1").optional(),
        })
        .strict(),
    ),
    eventV3(
      "process.containment-registered",
      z
        .object({
          process: z.enum(["agent", "testplay"]),
          startedEventId: EventIdSchema,
        })
        .strict(),
    ),
    eventV3("testplay.exited", ProcessMetadataSchema),
    eventV3(
      "process.drain-completed",
      z
        .object({
          process: z.enum(["agent", "testplay"]),
          startedEventId: EventIdSchema,
        })
        .strict(),
    ),
    eventV3("testplay.evidence-stored", z.object({ evidence: ArtifactRefSchema }).strict()),
    eventV3("testplay.verified", z.object({ evidence: ArtifactRefSchema }).strict()),
    eventV3(
      "source.checked",
      z
        .object({
          before: ArtifactRefSchema,
          after: ArtifactRefSchema,
          unchanged: z.boolean(),
        })
        .strict(),
    ),
    eventV3("transaction.outcome-decided", UnityTransactionDecisionSchema),
    eventV3(
      "control.accepted",
      z.object({ requestId: EventIdSchema, action: z.literal("cancel") }).strict(),
    ),
    eventV3(
      "workspace.release-started",
      z.object({ leaseId: z.string().min(1), requestId: z.string().min(1) }).strict(),
    ),
    eventV3(
      "workspace.release-failed",
      z.object({ leaseId: z.string().min(1), failure: FailureMetadataSchema }).strict(),
    ),
    eventV3(
      "workspace.released",
      z
        .object({
          leaseId: z.string().min(1),
          receipt: ArtifactRefSchema,
          cleanupState: z.literal("released"),
        })
        .strict(),
    ),
    eventV3(
      "workflow.completed",
      z
        .object({
          evidence: ArtifactRefSchema,
          release: ArtifactRefSchema,
          sourceAfter: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV3(
      "workflow.failed",
      z
        .object({
          failure: FailureMetadataSchema,
          release: ArtifactRefSchema.optional(),
          sourceAfter: ArtifactRefSchema.optional(),
        })
        .strict(),
    ),
    eventV3(
      "workflow.cancelled",
      z
        .object({
          release: ArtifactRefSchema.optional(),
          sourceAfter: ArtifactRefSchema.optional(),
        })
        .strict(),
    ),
  ])
  .superRefine((event, context) => {
    const requireKind = (artifact: ArtifactRef, kind: ArtifactKind, path: string[]): void => {
      if (artifact.kind !== kind) {
        context.addIssue({
          code: "custom",
          path,
          message: "Unity transaction event references the wrong Artifact kind.",
        });
      }
    };
    if (event.type === "workflow.started") {
      requireKind(event.payload.config, "workflow-config", ["payload", "config", "kind"]);
      requireKind(event.payload.task, "task", ["payload", "task", "kind"]);
    } else if (event.type === "source.baselined") {
      requireKind(event.payload.manifest, "unity-source-manifest", ["payload", "manifest", "kind"]);
    } else if (event.type === "workspace.acquire-started") {
      requireKind(event.payload.request, "workspace-acquire-request", [
        "payload",
        "request",
        "kind",
      ]);
    } else if (event.type === "workspace.acquired") {
      requireKind(event.payload.receipt, "workspace-acquire-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "testplay.evidence-stored" || event.type === "testplay.verified") {
      requireKind(event.payload.evidence, "testplay-evidence", ["payload", "evidence", "kind"]);
    } else if (event.type === "source.checked") {
      requireKind(event.payload.before, "unity-source-manifest", ["payload", "before", "kind"]);
      requireKind(event.payload.after, "unity-source-manifest", ["payload", "after", "kind"]);
    } else if (event.type === "workspace.released") {
      requireKind(event.payload.receipt, "workspace-release-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "workflow.completed") {
      requireKind(event.payload.evidence, "testplay-evidence", ["payload", "evidence", "kind"]);
      requireKind(event.payload.release, "workspace-release-receipt", [
        "payload",
        "release",
        "kind",
      ]);
      requireKind(event.payload.sourceAfter, "unity-source-manifest", [
        "payload",
        "sourceAfter",
        "kind",
      ]);
    }
    const agentScoped =
      event.type === "agent.started" ||
      event.type === "agent.exited" ||
      event.type === "agent.input-write-failed";
    const stepArtifact =
      event.type === "artifact.stored" &&
      ["step-input", "step-output"].includes(event.payload.artifact.kind);
    if ((agentScoped || stepArtifact) && event.stepId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "Agent-scoped Unity transaction event needs stepId.",
      });
    }
    if (
      event.type === "process.containment-registered" ||
      event.type === "process.drain-completed"
    ) {
      if (event.payload.process === "agent" && event.stepId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["stepId"],
          message: "An Agent process lifecycle event needs stepId.",
        });
      }
      if (event.payload.process === "testplay" && event.stepId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["stepId"],
          message: "A TestPlay process lifecycle event cannot have stepId.",
        });
      }
    }
    if (event.type.startsWith("workflow.") && event.stepId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "Workflow event cannot have stepId.",
      });
    }
  });
export type OrchestrationEventV3 = z.infer<typeof OrchestrationEventV3Schema>;

export type TerminalWorkflowEventV3 = Extract<
  OrchestrationEventV3,
  { type: "workflow.completed" | "workflow.failed" | "workflow.cancelled" }
>;
export const TERMINAL_WORKFLOW_EVENT_V3_TYPES = new Set<TerminalWorkflowEventV3["type"]>([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);

const EventV4BaseSchema = z.object({
  schemaVersion: z.literal(4),
  eventId: EventIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  stepId: StepIdSchema.optional(),
});
const eventV4 = <Type extends string, Payload extends z.ZodType>(type: Type, payload: Payload) =>
  EventV4BaseSchema.extend({ type: z.literal(type), payload }).strict();

const UnityBatchSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  })
  .strict()
  .refine((summary) => summary.total === summary.completed + summary.failed + summary.cancelled, {
    message: "Batch summary counts must add up to the total.",
  });

const UnityWorkLinkageSchema = z
  .object({
    parentRunId: RunIdSchema,
    workId: StepIdSchema,
    resourceId: ResourceIdSchema,
    resourceScope: z.enum(["batch-local-v1", "global-file-v1"]),
  })
  .strict();

const ResourceRequestPayloadSchema = z
  .object({ resourceId: ResourceIdSchema, requestId: EventIdSchema })
  .strict();
const ResourceLeasePayloadSchema = ResourceRequestPayloadSchema.extend({
  ticket: z.number().int().positive(),
  leaseId: EventIdSchema,
}).strict();

export const OrchestrationEventV4Schema = z
  .discriminatedUnion("type", [
    eventV4(
      "workflow.started",
      z.discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("unity-work-v2"),
            config: ArtifactRefSchema,
            task: ArtifactRefSchema,
            linkage: UnityWorkLinkageSchema,
          })
          .strict(),
        z
          .object({
            mode: z.literal("unity-batch-v1"),
            config: ArtifactRefSchema,
            workCount: z.number().int().positive(),
            maxParallelWorks: z.number().int().positive(),
            resourceScope: z.enum(["batch-local-v1", "global-file-v1"]),
          })
          .strict(),
      ]),
    ),
    eventV4("artifact.stored", z.object({ artifact: ArtifactRefSchema }).strict()),
    eventV4("source.baselined", z.object({ manifest: ArtifactRefSchema }).strict()),
    eventV4(
      "workspace.prepared",
      z.object({ workspaceId: z.string().min(1), sourceManifest: ArtifactRefSchema }).strict(),
    ),
    eventV4(
      "workspace.acquire-started",
      z.object({ request: ArtifactRefSchema, requestId: z.string().min(1) }).strict(),
    ),
    eventV4("workspace.acquire-failed", z.object({ failure: FailureMetadataSchema }).strict()),
    eventV4(
      "workspace.acquired",
      z
        .object({
          workspaceId: z.string().min(1),
          leaseId: z.string().min(1),
          receipt: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV4(
      "agent.started",
      z
        .object({
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512).optional(),
          containment: z.literal("deferred-v1").optional(),
        })
        .strict(),
    ),
    eventV4("agent.exited", ProcessMetadataSchema),
    eventV4("agent.input-write-failed", FailureMetadataSchema),
    eventV4("resource.acquire-started", ResourceRequestPayloadSchema),
    eventV4(
      "resource.queued",
      ResourceRequestPayloadSchema.extend({ ticket: z.number().int().positive() }).strict(),
    ),
    eventV4(
      "resource.acquire-failed",
      ResourceRequestPayloadSchema.extend({ failure: FailureMetadataSchema }).strict(),
    ),
    eventV4("resource.acquired", ResourceLeasePayloadSchema),
    eventV4("resource.acquire-cancelled", ResourceRequestPayloadSchema),
    eventV4("resource.release-started", ResourceLeasePayloadSchema),
    eventV4(
      "resource.release-failed",
      ResourceLeasePayloadSchema.extend({ failure: FailureMetadataSchema }).strict(),
    ),
    eventV4("resource.released", ResourceLeasePayloadSchema),
    eventV4(
      "testplay.started",
      z
        .object({
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512).optional(),
          containment: z.literal("deferred-v1").optional(),
        })
        .strict(),
    ),
    eventV4(
      "process.containment-registered",
      z
        .object({
          process: z.enum(["agent", "testplay"]),
          startedEventId: EventIdSchema,
        })
        .strict(),
    ),
    eventV4("testplay.exited", ProcessMetadataSchema),
    eventV4(
      "process.drain-completed",
      z
        .object({
          process: z.enum(["agent", "testplay"]),
          startedEventId: EventIdSchema,
        })
        .strict(),
    ),
    eventV4("testplay.evidence-stored", z.object({ evidence: ArtifactRefSchema }).strict()),
    eventV4("testplay.verified", z.object({ evidence: ArtifactRefSchema }).strict()),
    eventV4(
      "source.checked",
      z
        .object({
          before: ArtifactRefSchema,
          after: ArtifactRefSchema,
          unchanged: z.boolean(),
        })
        .strict(),
    ),
    eventV4(
      "patch.verified",
      z
        .object({
          patch: ArtifactRefSchema,
          baseManifest: ArtifactRefSchema,
          resultManifest: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV4("transaction.outcome-decided", UnityTransactionDecisionSchema),
    eventV4(
      "control.accepted",
      z.object({ requestId: EventIdSchema, action: z.literal("cancel") }).strict(),
    ),
    eventV4(
      "workspace.release-started",
      z.object({ leaseId: z.string().min(1), requestId: z.string().min(1) }).strict(),
    ),
    eventV4(
      "workspace.release-failed",
      z.object({ leaseId: z.string().min(1), failure: FailureMetadataSchema }).strict(),
    ),
    eventV4(
      "workspace.released",
      z
        .object({
          leaseId: z.string().min(1),
          receipt: ArtifactRefSchema,
          cleanupState: z.literal("released"),
        })
        .strict(),
    ),
    eventV4(
      "work.registered",
      z
        .object({
          workId: StepIdSchema,
          childRunId: RunIdSchema,
          resourceId: ResourceIdSchema,
        })
        .strict(),
    ),
    eventV4(
      "work.finished",
      z.discriminatedUnion("status", [
        z
          .object({
            workId: StepIdSchema,
            childRunId: RunIdSchema,
            status: z.literal("completed"),
            patch: ArtifactRefSchema,
          })
          .strict(),
        z
          .object({
            workId: StepIdSchema,
            childRunId: RunIdSchema,
            status: z.literal("failed"),
            failure: FailureMetadataSchema,
          })
          .strict(),
        z
          .object({
            workId: StepIdSchema,
            childRunId: RunIdSchema,
            status: z.literal("cancelled"),
            started: z.boolean(),
          })
          .strict(),
      ]),
    ),
    eventV4("workflow.cancelling", z.object({ requestId: EventIdSchema }).strict()),
    eventV4(
      "workflow.completed",
      z.union([
        z
          .object({
            evidence: ArtifactRefSchema,
            patch: ArtifactRefSchema,
            resultManifest: ArtifactRefSchema,
            release: ArtifactRefSchema,
            sourceAfter: ArtifactRefSchema,
          })
          .strict(),
        z.object({ summary: UnityBatchSummarySchema }).strict(),
      ]),
    ),
    eventV4(
      "workflow.failed",
      z.union([
        z
          .object({
            failure: FailureMetadataSchema,
            release: ArtifactRefSchema.optional(),
            sourceAfter: ArtifactRefSchema.optional(),
          })
          .strict(),
        z.object({ failure: FailureMetadataSchema, summary: UnityBatchSummarySchema }).strict(),
      ]),
    ),
    eventV4(
      "workflow.cancelled",
      z.union([
        z
          .object({
            release: ArtifactRefSchema.optional(),
            sourceAfter: ArtifactRefSchema.optional(),
          })
          .strict(),
        z.object({ summary: UnityBatchSummarySchema }).strict(),
      ]),
    ),
  ])
  .superRefine((event, context) => {
    const requireKind = (artifact: ArtifactRef, kind: ArtifactKind, path: string[]): void => {
      if (artifact.kind !== kind) {
        context.addIssue({ code: "custom", path, message: `Expected Artifact kind ${kind}.` });
      }
    };
    const requireMediaType = (
      artifact: ArtifactRef,
      mediaType: ArtifactMediaType,
      path: string[],
    ): void => {
      if (artifact.mediaType !== mediaType) {
        context.addIssue({ code: "custom", path, message: `Expected media type ${mediaType}.` });
      }
    };
    if (event.type === "workflow.started") {
      requireKind(event.payload.config, "workflow-config", ["payload", "config", "kind"]);
      if (event.payload.mode === "unity-work-v2") {
        requireKind(event.payload.task, "task", ["payload", "task", "kind"]);
      }
    } else if (event.type === "source.baselined") {
      requireKind(event.payload.manifest, "unity-source-manifest", ["payload", "manifest", "kind"]);
    } else if (event.type === "workspace.acquire-started") {
      requireKind(event.payload.request, "workspace-acquire-request", [
        "payload",
        "request",
        "kind",
      ]);
    } else if (event.type === "workspace.acquired") {
      requireKind(event.payload.receipt, "workspace-acquire-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "testplay.evidence-stored" || event.type === "testplay.verified") {
      requireKind(event.payload.evidence, "testplay-evidence", ["payload", "evidence", "kind"]);
    } else if (event.type === "source.checked") {
      requireKind(event.payload.before, "unity-source-manifest", ["payload", "before", "kind"]);
      requireKind(event.payload.after, "unity-source-manifest", ["payload", "after", "kind"]);
    } else if (event.type === "patch.verified") {
      requireKind(event.payload.patch, "unity-verified-patch", ["payload", "patch", "kind"]);
      requireMediaType(event.payload.patch, "application/vnd.honeybee.unity-patch+json", [
        "payload",
        "patch",
        "mediaType",
      ]);
      requireKind(event.payload.baseManifest, "unity-source-manifest", [
        "payload",
        "baseManifest",
        "kind",
      ]);
      requireKind(event.payload.resultManifest, "unity-workspace-manifest", [
        "payload",
        "resultManifest",
        "kind",
      ]);
    } else if (event.type === "workspace.released") {
      requireKind(event.payload.receipt, "workspace-release-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "work.finished" && event.payload.status === "completed") {
      requireKind(event.payload.patch, "unity-verified-patch", ["payload", "patch", "kind"]);
      requireMediaType(event.payload.patch, "application/vnd.honeybee.unity-patch+json", [
        "payload",
        "patch",
        "mediaType",
      ]);
    }
    const agentScoped =
      event.type === "agent.started" ||
      event.type === "agent.exited" ||
      event.type === "agent.input-write-failed";
    if (agentScoped && event.stepId === undefined) {
      context.addIssue({ code: "custom", path: ["stepId"], message: "Agent event needs stepId." });
    }
    if (event.type.startsWith("workflow.") && event.stepId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "Workflow event cannot have stepId.",
      });
    }
  });
export type OrchestrationEventV4 = z.infer<typeof OrchestrationEventV4Schema>;

export type TerminalWorkflowEventV4 = Extract<
  OrchestrationEventV4,
  { type: "workflow.completed" | "workflow.failed" | "workflow.cancelled" }
>;
export const TERMINAL_WORKFLOW_EVENT_V4_TYPES = new Set<TerminalWorkflowEventV4["type"]>([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);

const EventV5BaseSchema = z.object({
  schemaVersion: z.literal(5),
  eventId: EventIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  stepId: StepIdSchema.optional(),
});
const eventV5 = <Type extends string, Payload extends z.ZodType>(type: Type, payload: Payload) =>
  EventV5BaseSchema.extend({ type: z.literal(type), payload }).strict();

const EditorPoolRequestPayloadSchema = z
  .object({
    poolId: ResourceIdSchema,
    requestId: EventIdSchema,
    priority: UnityWorkPrioritySchema,
  })
  .strict();
const EditorPoolTicketPayloadSchema = EditorPoolRequestPayloadSchema.extend({
  ticket: z.number().int().positive(),
}).strict();
const EditorPoolLeasePayloadSchema = EditorPoolTicketPayloadSchema.extend({
  leaseId: EventIdSchema,
  slotId: UnityEditorSlotIdSchema,
}).strict();
const CapabilityIdentityPayloadSchema = z
  .object({
    capabilityId: StepIdSchema,
    index: z.number().int().nonnegative(),
    kind: z.enum(["compile", "warm-test"]),
  })
  .strict();

export const OrchestrationEventV5Schema = z
  .discriminatedUnion("type", [
    eventV5(
      "workflow.started",
      z.discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("unity-work-v3"),
            config: ArtifactRefSchema,
            task: ArtifactRefSchema,
            linkage: z
              .object({
                parentRunId: RunIdSchema.optional(),
                workId: StepIdSchema,
                poolId: ResourceIdSchema,
                priority: UnityWorkPrioritySchema,
                capabilityCount: z.number().int().nonnegative(),
              })
              .strict(),
          })
          .strict(),
        z
          .object({
            mode: z.literal("unity-batch-v2"),
            config: ArtifactRefSchema,
            workCount: z.number().int().positive(),
            maxParallelWorks: z.number().int().positive(),
            poolId: ResourceIdSchema,
            poolCapacity: z.number().int().min(1).max(32),
          })
          .strict(),
      ]),
    ),
    eventV5("artifact.stored", z.object({ artifact: ArtifactRefSchema }).strict()),
    eventV5("source.baselined", z.object({ manifest: ArtifactRefSchema }).strict()),
    eventV5(
      "workspace.prepared",
      z.object({ workspaceId: z.string().min(1), sourceManifest: ArtifactRefSchema }).strict(),
    ),
    eventV5(
      "workspace.acquire-started",
      z.object({ request: ArtifactRefSchema, requestId: z.string().min(1) }).strict(),
    ),
    eventV5("workspace.acquire-failed", z.object({ failure: FailureMetadataSchema }).strict()),
    eventV5(
      "workspace.acquired",
      z
        .object({
          workspaceId: z.string().min(1),
          leaseId: z.string().min(1),
          receipt: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV5(
      "agent.started",
      z
        .object({
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512).optional(),
          containment: z.literal("deferred-v1").optional(),
        })
        .strict(),
    ),
    eventV5("agent.exited", ProcessMetadataSchema),
    eventV5("agent.input-write-failed", FailureMetadataSchema),
    eventV5(
      "process.containment-registered",
      z.object({ process: z.literal("agent"), startedEventId: EventIdSchema }).strict(),
    ),
    eventV5(
      "process.drain-completed",
      z.object({ process: z.literal("agent"), startedEventId: EventIdSchema }).strict(),
    ),
    eventV5("editor.pool-requested", EditorPoolRequestPayloadSchema),
    eventV5("editor.pool-queued", EditorPoolTicketPayloadSchema),
    eventV5(
      "editor.pool-acquire-failed",
      EditorPoolRequestPayloadSchema.extend({ failure: FailureMetadataSchema }).strict(),
    ),
    eventV5("editor.pool-acquired", EditorPoolLeasePayloadSchema),
    eventV5("editor.pool-cancelled", EditorPoolRequestPayloadSchema),
    eventV5(
      "editor.launch-intended",
      z
        .object({
          launchId: EventIdSchema,
          slotId: UnityEditorSlotIdSchema,
          leaseId: EventIdSchema,
          intent: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV5(
      "editor.containment-registered",
      z
        .object({
          launchId: EventIdSchema,
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512),
          receipt: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV5("editor.launch-abandoned", z.object({ launchId: EventIdSchema }).strict()),
    eventV5("editor.activated", z.object({ launchId: EventIdSchema }).strict()),
    eventV5(
      "editor.ownership-established",
      z
        .object({
          launchId: EventIdSchema,
          editorId: EventIdSchema,
          slotId: UnityEditorSlotIdSchema,
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512),
          receipt: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV5(
      "editor.bridge-bound",
      z
        .object({
          editorId: EventIdSchema,
          bridgeSessionId: z.string().min(1).max(256),
          binding: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV5("capability.started", CapabilityIdentityPayloadSchema),
    eventV5(
      "capability.process-started",
      CapabilityIdentityPayloadSchema.extend({
        pid: z.number().int().positive(),
        processIdentity: z.string().min(1).max(512).optional(),
        containment: z.literal("deferred-v1").optional(),
      }).strict(),
    ),
    eventV5(
      "capability.process-registered",
      CapabilityIdentityPayloadSchema.extend({ startedEventId: EventIdSchema }).strict(),
    ),
    eventV5(
      "capability.process-exited",
      CapabilityIdentityPayloadSchema.extend(ProcessMetadataSchema.shape).strict(),
    ),
    eventV5(
      "capability.process-drained",
      CapabilityIdentityPayloadSchema.extend({ startedEventId: EventIdSchema }).strict(),
    ),
    eventV5(
      "capability.completed",
      CapabilityIdentityPayloadSchema.extend({ evidence: ArtifactRefSchema }).strict(),
    ),
    eventV5(
      "capability.failed",
      CapabilityIdentityPayloadSchema.extend({ failure: FailureMetadataSchema }).strict(),
    ),
    eventV5(
      "editor.stop-started",
      z.object({ editorId: EventIdSchema, launchId: EventIdSchema }).strict(),
    ),
    eventV5(
      "editor.exited",
      z
        .object({
          editorId: EventIdSchema,
          launchId: EventIdSchema,
          pid: z.number().int().positive(),
          processIdentity: z.string().min(1).max(512),
        })
        .strict(),
    ),
    eventV5(
      "editor.containment-drained",
      z.object({ launchId: EventIdSchema, receipt: ArtifactRefSchema }).strict(),
    ),
    eventV5("editor.pool-release-started", EditorPoolLeasePayloadSchema),
    eventV5(
      "editor.pool-release-failed",
      EditorPoolLeasePayloadSchema.extend({ failure: FailureMetadataSchema }).strict(),
    ),
    eventV5("editor.pool-released", EditorPoolLeasePayloadSchema),
    eventV5(
      "source.checked",
      z
        .object({ before: ArtifactRefSchema, after: ArtifactRefSchema, unchanged: z.boolean() })
        .strict(),
    ),
    eventV5(
      "patch.verified",
      z
        .object({
          patch: ArtifactRefSchema,
          baseManifest: ArtifactRefSchema,
          resultManifest: ArtifactRefSchema,
        })
        .strict(),
    ),
    eventV5("transaction.outcome-decided", UnityTransactionDecisionSchema),
    eventV5(
      "control.accepted",
      z.object({ requestId: EventIdSchema, action: z.literal("cancel") }).strict(),
    ),
    eventV5(
      "workspace.release-started",
      z.object({ leaseId: z.string().min(1), requestId: z.string().min(1) }).strict(),
    ),
    eventV5(
      "workspace.release-failed",
      z.object({ leaseId: z.string().min(1), failure: FailureMetadataSchema }).strict(),
    ),
    eventV5(
      "workspace.released",
      z
        .object({
          leaseId: z.string().min(1),
          receipt: ArtifactRefSchema,
          cleanupState: z.literal("released"),
        })
        .strict(),
    ),
    eventV5(
      "work.registered",
      z
        .object({
          workId: StepIdSchema,
          childRunId: RunIdSchema,
          priority: UnityWorkPrioritySchema,
          capabilityCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    eventV5(
      "work.finished",
      z.discriminatedUnion("status", [
        z
          .object({
            workId: StepIdSchema,
            childRunId: RunIdSchema,
            status: z.literal("completed"),
            patch: ArtifactRefSchema,
          })
          .strict(),
        z
          .object({
            workId: StepIdSchema,
            childRunId: RunIdSchema,
            status: z.literal("failed"),
            failure: FailureMetadataSchema,
          })
          .strict(),
        z
          .object({
            workId: StepIdSchema,
            childRunId: RunIdSchema,
            status: z.literal("cancelled"),
            started: z.boolean(),
          })
          .strict(),
      ]),
    ),
    eventV5("workflow.cancelling", z.object({ requestId: EventIdSchema }).strict()),
    eventV5(
      "workflow.completed",
      z.union([
        z
          .object({
            evidence: ArtifactRefSchema.optional(),
            patch: ArtifactRefSchema,
            resultManifest: ArtifactRefSchema,
            release: ArtifactRefSchema,
            sourceAfter: ArtifactRefSchema,
          })
          .strict(),
        z.object({ summary: UnityBatchSummarySchema }).strict(),
      ]),
    ),
    eventV5(
      "workflow.failed",
      z.union([
        z
          .object({
            failure: FailureMetadataSchema,
            release: ArtifactRefSchema.optional(),
            sourceAfter: ArtifactRefSchema.optional(),
          })
          .strict(),
        z.object({ failure: FailureMetadataSchema, summary: UnityBatchSummarySchema }).strict(),
      ]),
    ),
    eventV5(
      "workflow.cancelled",
      z.union([
        z
          .object({
            release: ArtifactRefSchema.optional(),
            sourceAfter: ArtifactRefSchema.optional(),
          })
          .strict(),
        z.object({ summary: UnityBatchSummarySchema }).strict(),
      ]),
    ),
  ])
  .superRefine((event, context) => {
    const requireKind = (artifact: ArtifactRef, kind: ArtifactKind, path: string[]): void => {
      if (artifact.kind !== kind) {
        context.addIssue({ code: "custom", path, message: `Expected Artifact kind ${kind}.` });
      }
    };
    if (event.type === "workflow.started") {
      requireKind(event.payload.config, "workflow-config", ["payload", "config", "kind"]);
      if (event.payload.mode === "unity-work-v3") {
        requireKind(event.payload.task, "task", ["payload", "task", "kind"]);
      }
    } else if (event.type === "source.baselined") {
      requireKind(event.payload.manifest, "unity-source-manifest", ["payload", "manifest", "kind"]);
    } else if (event.type === "workspace.acquire-started") {
      requireKind(event.payload.request, "workspace-acquire-request", [
        "payload",
        "request",
        "kind",
      ]);
    } else if (event.type === "workspace.acquired") {
      requireKind(event.payload.receipt, "workspace-acquire-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "editor.launch-intended") {
      requireKind(event.payload.intent, "editor-launch-intent", ["payload", "intent", "kind"]);
    } else if (event.type === "editor.containment-registered") {
      requireKind(event.payload.receipt, "editor-containment-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "editor.ownership-established") {
      requireKind(event.payload.receipt, "editor-ownership-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "editor.bridge-bound") {
      requireKind(event.payload.binding, "warm-bridge-binding", ["payload", "binding", "kind"]);
    } else if (event.type === "capability.completed") {
      requireKind(event.payload.evidence, "unity-capability-evidence", [
        "payload",
        "evidence",
        "kind",
      ]);
    } else if (event.type === "editor.containment-drained") {
      requireKind(event.payload.receipt, "editor-containment-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    } else if (event.type === "source.checked") {
      requireKind(event.payload.before, "unity-source-manifest", ["payload", "before", "kind"]);
      requireKind(event.payload.after, "unity-source-manifest", ["payload", "after", "kind"]);
    } else if (event.type === "patch.verified") {
      requireKind(event.payload.patch, "unity-verified-patch", ["payload", "patch", "kind"]);
      requireKind(event.payload.baseManifest, "unity-source-manifest", [
        "payload",
        "baseManifest",
        "kind",
      ]);
      requireKind(event.payload.resultManifest, "unity-workspace-manifest", [
        "payload",
        "resultManifest",
        "kind",
      ]);
    } else if (event.type === "workspace.released") {
      requireKind(event.payload.receipt, "workspace-release-receipt", [
        "payload",
        "receipt",
        "kind",
      ]);
    }
    const agentScoped =
      event.type === "agent.started" ||
      event.type === "agent.exited" ||
      event.type === "agent.input-write-failed" ||
      event.type === "process.containment-registered" ||
      event.type === "process.drain-completed";
    if (agentScoped && event.stepId === undefined) {
      context.addIssue({ code: "custom", path: ["stepId"], message: "Agent event needs stepId." });
    }
    if (event.type.startsWith("workflow.") && event.stepId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "Workflow event cannot have stepId.",
      });
    }
  });
export type OrchestrationEventV5 = z.infer<typeof OrchestrationEventV5Schema>;

export type TerminalWorkflowEventV5 = Extract<
  OrchestrationEventV5,
  { type: "workflow.completed" | "workflow.failed" | "workflow.cancelled" }
>;
export const TERMINAL_WORKFLOW_EVENT_V5_TYPES = new Set<TerminalWorkflowEventV5["type"]>([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);

export type AnyOrchestrationEvent =
  | OrchestrationEventV1
  | OrchestrationEventV2
  | OrchestrationEventV3
  | OrchestrationEventV4
  | OrchestrationEventV5;
