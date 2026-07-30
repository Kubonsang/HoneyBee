import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(256);

export const SessionIdSchema = identifierSchema.brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const ProjectIdSchema = identifierSchema.brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const WorkspaceIdSchema = identifierSchema.brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const AgentProfileIdSchema = identifierSchema.brand<"AgentProfileId">();
export type AgentProfileId = z.infer<typeof AgentProfileIdSchema>;

export const ToolProfileIdSchema = identifierSchema.brand<"ToolProfileId">();
export type ToolProfileId = z.infer<typeof ToolProfileIdSchema>;

export const EventIdSchema = identifierSchema.brand<"EventId">();
export type EventId = z.infer<typeof EventIdSchema>;

export const RunIdSchema = identifierSchema.brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;

export const RuntimeInstanceIdSchema = identifierSchema.brand<"RuntimeInstanceId">();
export type RuntimeInstanceId = z.infer<typeof RuntimeInstanceIdSchema>;
