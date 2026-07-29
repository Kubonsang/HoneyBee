import {
  AgentSessionSchema,
  EventIdSchema,
  IsoDateTimeSchema,
  ProjectIdSchema,
  SessionDraftSchema,
  SessionIdSchema,
  SessionTagSchema,
  WorkspaceIdSchema,
} from "@honeybee/domain";
import { z } from "zod";

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EventSourceSchema = z.enum(["runtime", "extension", "webview", "agent", "system"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EventSeveritySchema = z.enum(["debug", "info", "warning", "error"]);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

export const EventEnvelopeBaseSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    eventId: EventIdSchema,
    timestamp: IsoDateTimeSchema,
    projectId: ProjectIdSchema,
    sessionId: SessionIdSchema.nullable(),
    workspaceId: WorkspaceIdSchema.nullable(),
    source: EventSourceSchema,
    severity: EventSeveritySchema,
  })
  .strict();
export type EventEnvelopeBase = z.infer<typeof EventEnvelopeBaseSchema>;

const RuntimeReadyEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("runtime.ready"),
  payload: z.object({ runtimeVersion: z.string().min(1) }).strict(),
});

const RuntimeStoppedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("runtime.stopped"),
  payload: z
    .object({
      reason: z.enum(["requested", "eof", "crash"]),
      exitCode: z.number().int().nullable(),
    })
    .strict(),
});

const RuntimeErrorEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("runtime.error"),
  payload: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      recoverable: z.boolean(),
    })
    .strict(),
});

const SessionUpsertedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.upserted"),
  payload: z.object({ session: AgentSessionSchema }).strict(),
});

const SessionDeletedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.deleted"),
  payload: z.object({ sessionId: SessionIdSchema }).strict(),
});

const DraftSavedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("draft.saved"),
  payload: z.object({ draft: SessionDraftSchema }).strict(),
});

const DraftDeletedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("draft.deleted"),
  payload: z.object({ sessionId: SessionIdSchema }).strict(),
});

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  RuntimeReadyEventSchema,
  RuntimeStoppedEventSchema,
  RuntimeErrorEventSchema,
  SessionUpsertedEventSchema,
  SessionDeletedEventSchema,
  DraftSavedEventSchema,
  DraftDeletedEventSchema,
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

const WebviewReadyEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("webview.ready"),
  payload: z.object({ webviewVersion: z.string().min(1) }).strict(),
});

const SessionCreateRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.create.requested"),
  payload: z.object({ session: AgentSessionSchema }).strict(),
});

const SessionUpdateRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.update.requested"),
  payload: z.object({ session: AgentSessionSchema }).strict(),
});

const SessionDeleteRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.delete.requested"),
  payload: z.object({ sessionId: SessionIdSchema }).strict(),
});

const SessionSelectRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.select.requested"),
  payload: z.object({ sessionId: SessionIdSchema }).strict(),
});

const DraftSaveRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("draft.save.requested"),
  payload: z.object({ draft: SessionDraftSchema }).strict(),
});

const DraftDeleteRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("draft.delete.requested"),
  payload: z.object({ sessionId: SessionIdSchema }).strict(),
});

const SessionTagCreateRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.tag.create.requested"),
  payload: z
    .object({
      sessionId: SessionIdSchema,
      tag: SessionTagSchema,
    })
    .strict(),
});

const SessionTagUpdateRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.tag.update.requested"),
  payload: z
    .object({
      sessionId: SessionIdSchema,
      currentTag: SessionTagSchema,
      replacementTag: SessionTagSchema,
    })
    .strict(),
});

const SessionTagDeleteRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  type: z.literal("session.tag.delete.requested"),
  payload: z
    .object({
      sessionId: SessionIdSchema,
      tag: SessionTagSchema,
    })
    .strict(),
});

export const WebviewEventSchema = z.discriminatedUnion("type", [
  WebviewReadyEventSchema,
  SessionCreateRequestedEventSchema,
  SessionUpdateRequestedEventSchema,
  SessionDeleteRequestedEventSchema,
  SessionSelectRequestedEventSchema,
  DraftSaveRequestedEventSchema,
  DraftDeleteRequestedEventSchema,
  SessionTagCreateRequestedEventSchema,
  SessionTagUpdateRequestedEventSchema,
  SessionTagDeleteRequestedEventSchema,
]);
export type WebviewEvent = z.infer<typeof WebviewEventSchema>;

export const CentralEventSchema = z.union([RuntimeEventSchema, WebviewEventSchema]);
export type CentralEvent = z.infer<typeof CentralEventSchema>;

export const RuntimeToWebviewEventSchema = RuntimeEventSchema;
export type RuntimeToWebviewEvent = RuntimeEvent;

export const WebviewToRuntimeEventSchema = WebviewEventSchema;
export type WebviewToRuntimeEvent = WebviewEvent;
