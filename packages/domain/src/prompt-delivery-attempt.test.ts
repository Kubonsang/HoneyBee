import { describe, expect, it } from "vitest";

import {
  PromptDeliveryAttemptSchema,
  isValidPromptDeliveryAttemptSuccessor,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
} from "./index.js";

const prepared = (overrides: Partial<PromptDeliveryAttempt> = {}): PromptDeliveryAttempt =>
  PromptDeliveryAttemptSchema.parse({
    requestId: "request-1",
    sessionId: "session-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    contentLength: 14,
    phase: "prepared",
    preparedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  });

const transition = (
  attempt: PromptDeliveryAttempt,
  next: Parameters<typeof transitionPromptDeliveryAttempt>[1],
): PromptDeliveryAttempt => {
  const result = transitionPromptDeliveryAttempt(attempt, next);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
};

describe("PromptDeliveryAttempt", () => {
  it("accepts strict prepared identity without Prompt content", () => {
    const value = prepared();

    expect(PromptDeliveryAttemptSchema.safeParse(value).success).toBe(true);
    expect(JSON.stringify(value)).not.toContain("secret Prompt body");
    expect(value.contentLength).toBe(14);
  });

  it("rejects unknown fields, invalid digest, byte length, and schema version", () => {
    expect(
      PromptDeliveryAttemptSchema.safeParse({ ...prepared(), content: "forbidden" }).success,
    ).toBe(false);
    expect(
      PromptDeliveryAttemptSchema.safeParse({ ...prepared(), contentDigest: "sha256:no" }).success,
    ).toBe(false);
    expect(
      PromptDeliveryAttemptSchema.safeParse({ ...prepared(), contentLength: -1 }).success,
    ).toBe(false);
    expect(PromptDeliveryAttemptSchema.safeParse({ ...prepared(), schemaVersion: 2 }).success).toBe(
      false,
    );
  });

  it("enforces phase-specific timestamps and replacement IDs", () => {
    expect(
      PromptDeliveryAttemptSchema.safeParse({ ...prepared(), phase: "runtime-accepted" }).success,
    ).toBe(false);
    expect(
      PromptDeliveryAttemptSchema.safeParse({ ...prepared(), acceptedAt: prepared().preparedAt })
        .success,
    ).toBe(false);
    expect(
      PromptDeliveryAttemptSchema.safeParse({
        ...prepared(),
        phase: "resolved-assumed-delivered",
      }).success,
    ).toBe(false);
    expect(
      PromptDeliveryAttemptSchema.safeParse({
        ...prepared(),
        phase: "resolved-retried",
        resolvedAt: "2026-07-30T10:04:00.000Z",
        replacementRequestId: "request-1",
      }).success,
    ).toBe(false);
  });

  it("allows only monotonic transitions and preserves identity", () => {
    const dispatching = transition(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const unknown = transition(dispatching, {
      phase: "unknown",
      updatedAt: "2026-07-30T10:02:00.000Z",
    });
    const resolved = transition(unknown, {
      phase: "resolved-retried",
      updatedAt: "2026-07-30T10:03:00.000Z",
      resolvedAt: "2026-07-30T10:03:00.000Z",
      replacementRequestId: "request-2",
    });

    expect(resolved.requestId).toBe("request-1");
    expect(resolved.replacementRequestId).toBe("request-2");
    expect(
      transitionPromptDeliveryAttempt(resolved, {
        phase: "dispatching",
        updatedAt: "2026-07-30T10:04:00.000Z",
      }).ok,
    ).toBe(false);
    expect(isValidPromptDeliveryAttemptSuccessor(unknown, resolved)).toBe(true);
    expect(
      transitionPromptDeliveryAttempt(dispatching, {
        phase: "cancelled-before-dispatch",
        updatedAt: "2026-07-30T10:03:00.000Z",
        resolvedAt: "2026-07-30T10:03:00.000Z",
      }).ok,
    ).toBe(false);
    expect(
      isValidPromptDeliveryAttemptSuccessor(unknown, {
        ...resolved,
        sessionId: "other-session" as PromptDeliveryAttempt["sessionId"],
      }),
    ).toBe(false);
  });
});
