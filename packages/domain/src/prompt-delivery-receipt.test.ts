import { describe, expect, it } from "vitest";

import { PromptDeliveryReceiptSchema } from "./prompt-delivery-receipt.js";

const receipt = {
  requestId: "request-1",
  sessionId: "session-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
  contentLength: 12,
  deliveredAt: "2026-07-30T12:00:00.000Z",
  draftCleanup: "pending",
  schemaVersion: 1,
} as const;

describe("PromptDeliveryReceiptSchema", () => {
  it("accepts a strict, content-minimized receipt", () => {
    expect(PromptDeliveryReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(PromptDeliveryReceiptSchema.safeParse({ ...receipt, content: "secret" }).success).toBe(
      false,
    );
  });

  it.each([
    "sha256:ABCDEF",
    "sha1:0000000000000000000000000000000000000000",
    `sha256:${"g".repeat(64)}`,
  ])("rejects invalid digest %s", (contentDigest) => {
    expect(PromptDeliveryReceiptSchema.safeParse({ ...receipt, contentDigest }).success).toBe(
      false,
    );
  });

  it("rejects invalid dates, cleanup states, lengths, and schema versions", () => {
    expect(
      PromptDeliveryReceiptSchema.safeParse({ ...receipt, deliveredAt: "yesterday" }).success,
    ).toBe(false);
    expect(
      PromptDeliveryReceiptSchema.safeParse({ ...receipt, draftCleanup: "unknown" }).success,
    ).toBe(false);
    expect(PromptDeliveryReceiptSchema.safeParse({ ...receipt, contentLength: -1 }).success).toBe(
      false,
    );
    expect(PromptDeliveryReceiptSchema.safeParse({ ...receipt, schemaVersion: 2 }).success).toBe(
      false,
    );
  });
});
