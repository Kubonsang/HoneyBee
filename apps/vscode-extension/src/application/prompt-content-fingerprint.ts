import { createHash } from "node:crypto";

import type { PromptDeliveryReceipt } from "@honeybee/domain";

/** SHA-256 and byte length derived from the exact UTF-8 Prompt content. */
export interface PromptContentFingerprint {
  readonly contentDigest: string;
  readonly contentLength: number;
}

/** Fingerprints exact content without trimming or Unicode/newline normalization. */
export const fingerprintPromptContent = (content: string): PromptContentFingerprint => {
  const bytes = Buffer.from(content, "utf8");
  return {
    contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    contentLength: bytes.byteLength,
  };
};

/** Compares a receipt with exact Draft content using the shared fingerprint function. */
export const receiptMatchesPromptContent = (
  receipt: Pick<PromptDeliveryReceipt, "contentDigest" | "contentLength">,
  content: string,
): boolean => {
  const fingerprint = fingerprintPromptContent(content);
  return (
    fingerprint.contentDigest === receipt.contentDigest &&
    fingerprint.contentLength === receipt.contentLength
  );
};
