import { z } from "zod";

import {
  ArtifactRefSchema,
  ContentDigestSchema,
  EventIdSchema,
  RunIdSchema,
  StepIdSchema,
} from "./schemas.js";

export const AgentAdapterV1Schema = z.enum([
  "stdio-framed-v2",
  "codex-app-server-v1",
  "opencode-acp-v1",
]);
export type AgentAdapterV1 = z.infer<typeof AgentAdapterV1Schema>;

export const AgentCapabilitiesV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    adapter: AgentAdapterV1Schema,
    toolApproval: z.enum(["root-only", "unsupported"]),
    skills: z.enum(["exact-isolation", "observe-only", "unsupported"]),
    plan: z.literal("unsupported"),
    resume: z.literal("unsupported"),
    steer: z.literal("unsupported"),
    userInput: z.literal("unsupported"),
    subagentApproval: z.literal("unsupported"),
    plugins: z.literal("disabled"),
  })
  .strict();
export type AgentCapabilitiesV1 = z.infer<typeof AgentCapabilitiesV1Schema>;

export const AgentApprovalKindV1Schema = z.enum([
  "command",
  "file-change",
  "permissions",
  "unknown",
]);
export type AgentApprovalKindV1 = z.infer<typeof AgentApprovalKindV1Schema>;

export const AgentApprovalDecisionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: EventIdSchema,
    decision: z.enum(["allow-once", "deny"]),
    source: z.enum(["policy", "user"]),
    decidedAt: z.string().datetime(),
  })
  .strict();
export type AgentApprovalDecisionV1 = z.infer<typeof AgentApprovalDecisionV1Schema>;

export const AgentApprovalRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: EventIdSchema,
    runId: RunIdSchema,
    stepId: StepIdSchema,
    kind: AgentApprovalKindV1Schema,
    providerRequestId: z.union([z.string(), z.number().safe()]),
    summary: z.string().trim().min(1).max(500),
    requestArtifact: ArtifactRefSchema,
  })
  .strict();
export type AgentApprovalRequestV1 = z.infer<typeof AgentApprovalRequestV1Schema>;

export const AgentSkillObservationV1Schema = z
  .object({
    name: z.string().trim().min(1).max(120),
    source: z.enum(["workspace", "provider"]),
    state: z.enum(["observed", "verified", "changed", "blocked"]),
    contentDigest: ContentDigestSchema.optional(),
  })
  .strict();
export type AgentSkillObservationV1 = z.infer<typeof AgentSkillObservationV1Schema>;

export const AgentSkillManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    isolation: z.enum(["exact-isolation", "observe-only"]),
    skills: z.array(AgentSkillObservationV1Schema).max(256),
  })
  .strict();
export type AgentSkillManifestV1 = z.infer<typeof AgentSkillManifestV1Schema>;

export type AgentSessionLifecycleEventV1 =
  | Readonly<{ type: "admission-queued" }>
  | Readonly<{ type: "admission-entered"; waitMs: number }>
  | Readonly<{
      type: "session-opened";
      adapter: Exclude<AgentAdapterV1, "stdio-framed-v2">;
      sessionIdDigest: z.infer<typeof ContentDigestSchema>;
      capabilities: AgentCapabilitiesV1;
    }>
  | Readonly<{ type: "turn-started"; turnIdDigest: z.infer<typeof ContentDigestSchema> }>
  | Readonly<{
      type: "skills-observed";
      isolation: "observe-only";
      serializedManifest: string;
    }>
  | Readonly<{
      type: "approval-requested";
      approvalId: z.infer<typeof EventIdSchema>;
      providerRequestId: string | number;
      kind: AgentApprovalKindV1;
      summary: string;
      serializedRequest: string;
    }>
  | Readonly<{
      type: "approval-resolved";
      decision: AgentApprovalDecisionV1;
    }>
  | Readonly<{
      type: "approval-delivered";
      approvalId: z.infer<typeof EventIdSchema>;
    }>
  | Readonly<{
      type: "turn-completed";
      turnIdDigest: z.infer<typeof ContentDigestSchema>;
      status: "completed" | "failed" | "interrupted";
      outputBytes: number;
    }>
  | Readonly<{
      type: "session-closed";
      reason: "completed" | "failed" | "interrupted";
      serializedTranscript: string;
    }>;

export interface AgentSessionLifecycleObserverV1 {
  onEvent(event: AgentSessionLifecycleEventV1): Promise<void>;
}
