import { z } from "zod";

import { SessionIdSchema } from "./ids.js";
import { IsoDateTimeSchema } from "./session.js";

export const PromptContentDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/**
 * Minimal durable evidence that RuntimeClientPort.sendInput() returned successfully.
 * Prompt content is intentionally excluded.
 */
export const PromptDeliveryReceiptSchema = z
  .object({
    requestId: z.string().trim().min(1).max(256),
    sessionId: SessionIdSchema,
    contentDigest: PromptContentDigestSchema,
    contentLength: z.number().int().nonnegative(),
    deliveredAt: IsoDateTimeSchema,
    draftCleanup: z.enum(["pending", "cleared"]),
    schemaVersion: z.literal(1),
  })
  .strict();

/** Durable, content-minimized evidence of a successful Runtime input call. */
export type PromptDeliveryReceipt = z.infer<typeof PromptDeliveryReceiptSchema>;
