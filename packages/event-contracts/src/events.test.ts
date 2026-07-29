import { describe, expect, it } from "vitest";

import { CentralEventSchema, RuntimeEventSchema, WebviewEventSchema } from "./index.js";

const envelope = {
  schemaVersion: 1,
  eventId: "event-1",
  timestamp: "2026-07-29T12:00:00.000Z",
  projectId: "project-1",
  sessionId: "session-1",
  workspaceId: null,
} as const;

const agentSession = {
  id: "session-1",
  title: "Runtime contract",
  agentProfileId: "codex",
  tags: ["unity"],
  relatedSessionIds: [],
  status: "running",
  createdAt: "2026-07-29T12:00:00.000Z",
  updatedAt: "2026-07-29T12:00:00.000Z",
} as const;

describe("central event contracts", () => {
  it("round-trips the exact AgentSession model in a Runtime event", () => {
    const event = {
      ...envelope,
      type: "session.upserted",
      source: "runtime",
      severity: "info",
      payload: { session: agentSession },
    };

    const parsed = RuntimeEventSchema.parse(JSON.parse(JSON.stringify(event)));

    expect(parsed).toEqual(event);
    expect(CentralEventSchema.safeParse(parsed).success).toBe(true);
  });

  it("accepts Webview session and draft commands", () => {
    const sessionCommand = WebviewEventSchema.safeParse({
      ...envelope,
      type: "session.create.requested",
      source: "webview",
      severity: "info",
      payload: { session: agentSession },
    });
    const draftCommand = WebviewEventSchema.safeParse({
      ...envelope,
      type: "draft.save.requested",
      source: "webview",
      severity: "info",
      payload: {
        draft: {
          sessionId: "session-1",
          content: "Remember this input",
          updatedAt: "2026-07-29T12:01:00.000Z",
        },
      },
    });

    expect(sessionCommand.success).toBe(true);
    expect(draftCommand.success).toBe(true);
  });

  it("rejects legacy session fields, unknown events, versions, and payload fields", () => {
    const legacySession = RuntimeEventSchema.safeParse({
      ...envelope,
      type: "session.upserted",
      source: "runtime",
      severity: "info",
      payload: { session: { ...agentSession, projectId: "legacy" } },
    });
    const unknownType = CentralEventSchema.safeParse({
      ...envelope,
      type: "session.unknown",
      source: "runtime",
      severity: "info",
      payload: {},
    });
    const unknownVersion = CentralEventSchema.safeParse({
      ...envelope,
      schemaVersion: 2,
      type: "runtime.ready",
      source: "runtime",
      severity: "info",
      payload: { runtimeVersion: "0.1.0" },
    });
    const extraPayloadField = CentralEventSchema.safeParse({
      ...envelope,
      type: "runtime.ready",
      source: "runtime",
      severity: "info",
      payload: { runtimeVersion: "0.1.0", ignored: true },
    });

    expect(legacySession.success).toBe(false);
    expect(unknownType.success).toBe(false);
    expect(unknownVersion.success).toBe(false);
    expect(extraPayloadField.success).toBe(false);
  });
});
