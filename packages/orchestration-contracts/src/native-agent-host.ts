import { z } from "zod";

import {
  AgentCommandSchema,
  ContentDigestSchema,
  EventIdSchema,
  RunIdSchema,
  UnityWorkPrioritySchema,
} from "./schemas.js";

export const NativeAgentProviderV1Schema = z.enum(["codex", "opencode", "claude", "custom"]);
export type NativeAgentProviderV1 = z.infer<typeof NativeAgentProviderV1Schema>;

export const NativeAgentLaunchNonceV1Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export type NativeAgentLaunchNonceV1 = z.infer<typeof NativeAgentLaunchNonceV1Schema>;

const ProcessIdentitySchema = z.string().min(1).max(512);
const WorkspaceIdSchema = z.string().min(1).max(256);
const AbsolutePathValueSchema = z.string().min(1).max(32_768);

export const NativeAgentHostLaunchIntentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    ownerRunId: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    providerId: NativeAgentProviderV1Schema,
    priority: UnityWorkPrioritySchema,
    receiptDirectory: AbsolutePathValueSchema,
    hostExecutablePath: AbsolutePathValueSchema,
    hostExecutableDigest: ContentDigestSchema,
    registrationTimeoutMs: z.number().int().positive().max(300_000),
    activationTimeoutMs: z.number().int().positive().max(300_000),
    shutdownTimeoutMs: z.number().int().positive().max(600_000),
    createdAt: z.string().datetime(),
  })
  .strict();
export type NativeAgentHostLaunchIntentV1 = z.infer<typeof NativeAgentHostLaunchIntentV1Schema>;

/** Volatile IPC only. This value must never be published as a receipt or Journal payload. */
export const NativeAgentHostActivationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    providerId: NativeAgentProviderV1Schema,
    command: AgentCommandSchema,
    executableDigest: ContentDigestSchema,
    providerSessionDirectory: AbsolutePathValueSchema.optional(),
  })
  .strict();
export type NativeAgentHostActivationV1 = z.infer<typeof NativeAgentHostActivationV1Schema>;

export const NativeAgentHostReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    hostPid: z.number().int().positive(),
    processIdentity: ProcessIdentitySchema,
    containmentProtocol: z.literal("native-agent-host-v1"),
    workspaceId: WorkspaceIdSchema,
    publishedAt: z.string().datetime(),
  })
  .strict();
export type NativeAgentHostReceiptV1 = z.infer<typeof NativeAgentHostReceiptV1Schema>;

export const NativeAgentProcessReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    providerId: NativeAgentProviderV1Schema,
    targetPid: z.number().int().positive(),
    processIdentity: ProcessIdentitySchema,
    executableDigest: ContentDigestSchema,
    createdSuspendedAt: z.string().datetime(),
    providerSessionDirectory: AbsolutePathValueSchema.optional(),
  })
  .strict();
export type NativeAgentProcessReceiptV1 = z.infer<typeof NativeAgentProcessReceiptV1Schema>;

export const NativeAgentActivationReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    targetPid: z.number().int().positive(),
    processIdentity: ProcessIdentitySchema,
    bootstrapKillOnCloseCleared: z.literal(true),
    bootstrapJobHandleClosed: z.literal(true),
    activatedAt: z.string().datetime(),
  })
  .strict();
export type NativeAgentActivationReceiptV1 = z.infer<typeof NativeAgentActivationReceiptV1Schema>;

export const NativeAgentCancelRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: EventIdSchema,
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    requestedAt: z.string().datetime(),
  })
  .strict();
export type NativeAgentCancelRequestV1 = z.infer<typeof NativeAgentCancelRequestV1Schema>;

export const NativeAgentCancelAcceptedV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: EventIdSchema,
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    acceptedAt: z.string().datetime(),
  })
  .strict();
export type NativeAgentCancelAcceptedV1 = z.infer<typeof NativeAgentCancelAcceptedV1Schema>;

export const NativeAgentAbandonedReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    reason: z.enum(["registration-timeout", "host-missing-before-process"]),
    reconciledAt: z.string().datetime(),
  })
  .strict();
export type NativeAgentAbandonedReceiptV1 = z.infer<typeof NativeAgentAbandonedReceiptV1Schema>;

export const NativeAgentExitReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    launchId: EventIdSchema,
    nonce: NativeAgentLaunchNonceV1Schema,
    hostPid: z.number().int().positive(),
    hostProcessIdentity: ProcessIdentitySchema,
    targetPid: z.number().int().positive().optional(),
    targetProcessIdentity: ProcessIdentitySchema.optional(),
    exitCode: z.number().int().nullable(),
    termination: z.enum(["exited", "cancelled", "launch-failed", "host-failed"]),
    descendantsDrained: z.literal(true),
    exitedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if ((receipt.targetPid === undefined) !== (receipt.targetProcessIdentity === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["targetPid"],
        message: "Target PID and identity must be present or absent together.",
      });
    }
  });
export type NativeAgentExitReceiptV1 = z.infer<typeof NativeAgentExitReceiptV1Schema>;

export const NativeAgentHostPhaseV1Schema = z.enum([
  "intended",
  "host-registered",
  "process-registered",
  "active",
  "exited",
  "abandoned-before-registration",
  "indeterminate",
]);
export type NativeAgentHostPhaseV1 = z.infer<typeof NativeAgentHostPhaseV1Schema>;
