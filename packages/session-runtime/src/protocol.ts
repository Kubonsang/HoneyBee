import { RunIdSchema, RuntimeInstanceIdSchema, SessionIdSchema } from "@honeybee/domain";
import { z } from "zod";

export const RUNTIME_PROTOCOL_VERSION = 2 as const;

export const RuntimeLaunchSpecSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()),
    cwd: z.string().trim().min(1),
    env: z.record(z.string(), z.string()),
    shell: z.boolean(),
  })
  .strict();

export const TerminalSizeSchema = z
  .object({
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

export const RuntimeShutdownReasonSchema = z.enum(["extension-shutdown", "runtime-shutdown"]);
export type RuntimeShutdownReason = z.infer<typeof RuntimeShutdownReasonSchema>;

export const RuntimeHelloSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    runtimeInstanceId: RuntimeInstanceIdSchema,
    pid: z.number().int().positive(),
  })
  .strict();
export type RuntimeHello = z.infer<typeof RuntimeHelloSchema>;

export const RuntimeShutdownResultSchema = z
  .object({
    state: z.literal("stopped"),
    stoppedRuns: z.number().int().nonnegative(),
    unresolvedRuns: z.number().int().nonnegative(),
  })
  .strict();
export type RuntimeShutdownResult = z.infer<typeof RuntimeShutdownResultSchema>;

const RequestBaseSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("request"),
    id: z.string().min(1).max(256),
  })
  .strict();

const RuntimeHelloRequestSchema = RequestBaseSchema.extend({
  method: z.literal("runtime.hello"),
  params: z.object({}).strict(),
});

const AgentStartRequestSchema = RequestBaseSchema.extend({
  method: z.literal("agent.start"),
  params: z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      launchSpec: RuntimeLaunchSpecSchema,
      size: TerminalSizeSchema,
      logFilePath: z.string().min(1).optional(),
    })
    .strict(),
});

const runIdentity = { sessionId: SessionIdSchema, runId: RunIdSchema } as const;

const AgentInputRequestSchema = RequestBaseSchema.extend({
  method: z.literal("agent.input"),
  params: z.object({ ...runIdentity, data: z.string() }).strict(),
});

const AgentResizeRequestSchema = RequestBaseSchema.extend({
  method: z.literal("agent.resize"),
  params: z.object({ ...runIdentity, size: TerminalSizeSchema }).strict(),
});

const AgentInterruptRequestSchema = RequestBaseSchema.extend({
  method: z.literal("agent.interrupt"),
  params: z.object(runIdentity).strict(),
});

const AgentStopRequestSchema = RequestBaseSchema.extend({
  method: z.literal("agent.stop"),
  params: z.object({ ...runIdentity, force: z.boolean().optional() }).strict(),
});

const AgentSnapshotRequestSchema = RequestBaseSchema.extend({
  method: z.literal("agent.snapshot"),
  params: z.object(runIdentity).strict(),
});

const RuntimeShutdownRequestSchema = RequestBaseSchema.extend({
  method: z.literal("runtime.shutdown"),
  params: z.object({ reason: RuntimeShutdownReasonSchema }).strict(),
});

export const RuntimeRequestSchema = z.discriminatedUnion("method", [
  RuntimeHelloRequestSchema,
  AgentStartRequestSchema,
  AgentInputRequestSchema,
  AgentResizeRequestSchema,
  AgentInterruptRequestSchema,
  AgentStopRequestSchema,
  AgentSnapshotRequestSchema,
  RuntimeShutdownRequestSchema,
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

export const RuntimeErrorPayloadSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RuntimeErrorPayload = z.infer<typeof RuntimeErrorPayloadSchema>;

export const RuntimeSuccessResponseSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("response"),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const RuntimeFailureResponseSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("response"),
    id: z.string().min(1),
    ok: z.literal(false),
    error: RuntimeErrorPayloadSchema,
  })
  .strict();

export const RuntimeResponseSchema = z.discriminatedUnion("ok", [
  RuntimeSuccessResponseSchema,
  RuntimeFailureResponseSchema,
]);
export type RuntimeResponse = z.infer<typeof RuntimeResponseSchema>;

const runEventIdentity = {
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
} as const;

const PtyStartedEventSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("event"),
    event: z.literal("pty.started"),
    ...runEventIdentity,
    seq: z.number().int().nonnegative(),
    pid: z.number().int().nonnegative(),
    logFilePath: z.string().min(1),
  })
  .strict();

const PtyDataEventSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("event"),
    event: z.literal("pty.data"),
    ...runEventIdentity,
    seq: z.number().int().nonnegative(),
    data: z.string(),
  })
  .strict();

const PtyExitEventSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("event"),
    event: z.literal("pty.exit"),
    ...runEventIdentity,
    seq: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
    reason: z.enum([
      "exited",
      "interrupted",
      "stopped",
      "force-killed",
      "spawn-failed",
      "extension-shutdown",
      "runtime-shutdown",
    ]),
  })
  .strict();

const RuntimeProtocolErrorEventSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("event"),
    event: z.literal("runtime.protocol-error"),
    error: RuntimeErrorPayloadSchema,
  })
  .strict();

export const RuntimeEventMessageSchema = z.discriminatedUnion("event", [
  PtyStartedEventSchema,
  PtyDataEventSchema,
  PtyExitEventSchema,
  RuntimeProtocolErrorEventSchema,
]);
export type RuntimeEventMessage = z.infer<typeof RuntimeEventMessageSchema>;

export const RuntimeWireMessageSchema = z.union([
  RuntimeRequestSchema,
  RuntimeResponseSchema,
  RuntimeEventMessageSchema,
]);
export type RuntimeWireMessage = z.infer<typeof RuntimeWireMessageSchema>;

export const encodeRuntimeMessage = (message: RuntimeWireMessage): string =>
  `${JSON.stringify(message)}\n`;
