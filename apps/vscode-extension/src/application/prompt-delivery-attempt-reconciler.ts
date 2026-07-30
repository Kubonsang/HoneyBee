import {
  PromptDeliveryReceiptSchema,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
  type PromptDeliveryReceipt,
  type SessionDraft,
  type SessionId,
} from "@honeybee/domain";
import type {
  DraftRepository,
  PromptAttemptRetentionPolicy,
  PromptDeliveryAttemptRepository,
  PromptDeliveryReceiptRepository,
} from "@honeybee/persistence";

import { DEFAULT_PROMPT_ATTEMPT_RETENTION_POLICY } from "./prompt-delivery.js";
import { receiptMatchesPromptContent } from "./prompt-content-fingerprint.js";

export type PromptRecoveryDraftMatch = "exact" | "different" | "missing";

export interface PromptRecoveryIssueRecord {
  readonly requestId: string;
  readonly sessionId: SessionId;
  readonly outcome: "unknown";
  readonly draftMatch: PromptRecoveryDraftMatch;
  readonly occurredAt: string;
}

export type PromptAttemptReconciliationEvent =
  | {
      readonly type: "prepared-cancelled" | "receipt-reconstructed" | "attempt-finalized";
      readonly sessionId: SessionId;
      readonly requestId: string;
    }
  | {
      readonly type: "unknown";
      readonly sessionId: SessionId;
      readonly requestId: string;
    }
  | {
      readonly type: "failed" | "conflict";
      readonly code:
        | "attempt-list-failed"
        | "receipt-list-failed"
        | "draft-list-failed"
        | "attempt-cancel-failed"
        | "attempt-unknown-save-failed"
        | "receipt-reconstruct-failed"
        | "attempt-finalize-failed"
        | "attempt-reconciliation-conflict"
        | "attempt-prune-failed";
      readonly sessionId?: SessionId;
      readonly requestId?: string;
    };

export interface PromptAttemptReconciliationReport {
  readonly scannedAttempts: number;
  readonly issues: readonly PromptRecoveryIssueRecord[];
  readonly events: readonly PromptAttemptReconciliationEvent[];
  readonly prunedAttempts: number;
}

export interface PromptDeliveryAttemptReconcilerDependencies {
  readonly attempts: PromptDeliveryAttemptRepository;
  readonly receipts: PromptDeliveryReceiptRepository;
  readonly drafts: DraftRepository;
  readonly retentionPolicy?: PromptAttemptRetentionPolicy;
}

const receiptMatchesAttempt = (
  receipt: PromptDeliveryReceipt,
  attempt: PromptDeliveryAttempt,
): boolean =>
  receipt.requestId === attempt.requestId &&
  receipt.sessionId === attempt.sessionId &&
  receipt.contentDigest === attempt.contentDigest &&
  receipt.contentLength === attempt.contentLength &&
  (attempt.acceptedAt === undefined || receipt.deliveredAt === attempt.acceptedAt);

const draftMatchFor = (
  attempt: PromptDeliveryAttempt,
  draft: SessionDraft | undefined,
): PromptRecoveryDraftMatch => {
  if (draft === undefined) return "missing";
  const wasNotNewer = Date.parse(draft.updatedAt) <= Date.parse(attempt.updatedAt);
  return wasNotNewer && receiptMatchesPromptContent(attempt, draft.content) ? "exact" : "different";
};

const issueFor = (
  attempt: PromptDeliveryAttempt,
  draft: SessionDraft | undefined,
): PromptRecoveryIssueRecord => ({
  requestId: attempt.requestId,
  sessionId: attempt.sessionId,
  outcome: "unknown",
  draftMatch: draftMatchFor(attempt, draft),
  occurredAt: attempt.updatedAt,
});

/** Reconciles durable Attempts before Receipt/Draft restore without invoking Runtime input. */
export class PromptDeliveryAttemptReconciler {
  public constructor(private readonly dependencies: PromptDeliveryAttemptReconcilerDependencies) {}

  public async reconcile(): Promise<PromptAttemptReconciliationReport> {
    const attemptsResult = await this.dependencies.attempts.list();
    if (!attemptsResult.ok) {
      return this.report(0, [], [{ type: "failed", code: "attempt-list-failed" }]);
    }
    const [receiptsResult, draftsResult] = await Promise.all([
      this.dependencies.receipts.list(),
      this.dependencies.drafts.list(),
    ]);
    if (!receiptsResult.ok || !draftsResult.ok) {
      const events: PromptAttemptReconciliationEvent[] = [];
      if (!receiptsResult.ok) events.push({ type: "failed", code: "receipt-list-failed" });
      if (!draftsResult.ok) events.push({ type: "failed", code: "draft-list-failed" });
      const drafts = draftsResult.ok
        ? new Map(draftsResult.value.map((draft) => [draft.sessionId, draft]))
        : new Map<SessionId, SessionDraft>();
      const issues = attemptsResult.value
        .filter((attempt) => attempt.phase === "dispatching" || attempt.phase === "unknown")
        .map((attempt) => issueFor(attempt, drafts.get(attempt.sessionId)));
      return this.report(attemptsResult.value.length, issues, events);
    }

    const receiptsByRequest = new Map(
      receiptsResult.value.map((receipt) => [receipt.requestId, receipt]),
    );
    const draftsBySession = new Map(draftsResult.value.map((draft) => [draft.sessionId, draft]));
    const issues: PromptRecoveryIssueRecord[] = [];
    const events: PromptAttemptReconciliationEvent[] = [];

    for (const attempt of attemptsResult.value) {
      if (
        attempt.phase === "cancelled-before-dispatch" ||
        attempt.phase === "resolved-assumed-delivered" ||
        attempt.phase === "resolved-retried"
      ) {
        continue;
      }

      const receipt = receiptsByRequest.get(attempt.requestId);
      if (receipt !== undefined) {
        if (!receiptMatchesAttempt(receipt, attempt)) {
          events.push({
            type: "conflict",
            code: "attempt-reconciliation-conflict",
            sessionId: attempt.sessionId,
            requestId: attempt.requestId,
          });
          if (attempt.phase === "dispatching" || attempt.phase === "unknown") {
            issues.push(issueFor(attempt, draftsBySession.get(attempt.sessionId)));
          }
          continue;
        }
        const deleted = await this.dependencies.attempts.delete(attempt.requestId);
        events.push(
          deleted.ok
            ? {
                type: "attempt-finalized",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              }
            : {
                type: "failed",
                code: "attempt-finalize-failed",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              },
        );
        continue;
      }

      if (attempt.phase === "prepared") {
        const resolvedAt = attempt.updatedAt;
        const cancelled = transitionPromptDeliveryAttempt(attempt, {
          phase: "cancelled-before-dispatch",
          updatedAt: resolvedAt,
          resolvedAt,
        });
        const saved = cancelled.ok
          ? await this.dependencies.attempts.save(cancelled.value)
          : cancelled;
        events.push(
          saved.ok
            ? {
                type: "prepared-cancelled",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              }
            : {
                type: "failed",
                code: "attempt-cancel-failed",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              },
        );
        continue;
      }

      if (attempt.phase === "dispatching") {
        const unknown = transitionPromptDeliveryAttempt(attempt, {
          phase: "unknown",
          updatedAt: attempt.updatedAt,
        });
        const saved = unknown.ok ? await this.dependencies.attempts.save(unknown.value) : unknown;
        const effective = saved.ok ? saved.value : attempt;
        issues.push(issueFor(effective, draftsBySession.get(attempt.sessionId)));
        events.push(
          saved.ok
            ? { type: "unknown", sessionId: attempt.sessionId, requestId: attempt.requestId }
            : {
                type: "failed",
                code: "attempt-unknown-save-failed",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              },
        );
        continue;
      }

      if (attempt.phase === "runtime-accepted") {
        const reconstructed = PromptDeliveryReceiptSchema.parse({
          requestId: attempt.requestId,
          sessionId: attempt.sessionId,
          contentDigest: attempt.contentDigest,
          contentLength: attempt.contentLength,
          deliveredAt: attempt.acceptedAt,
          draftCleanup: "pending",
          schemaVersion: 1,
        });
        const stored = await this.dependencies.receipts.save(reconstructed);
        if (!stored.ok) {
          events.push({
            type: "failed",
            code: "receipt-reconstruct-failed",
            sessionId: attempt.sessionId,
            requestId: attempt.requestId,
          });
          continue;
        }
        const deleted = await this.dependencies.attempts.delete(attempt.requestId);
        events.push(
          deleted.ok
            ? {
                type: "receipt-reconstructed",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              }
            : {
                type: "failed",
                code: "attempt-finalize-failed",
                sessionId: attempt.sessionId,
                requestId: attempt.requestId,
              },
        );
        continue;
      }

      issues.push(issueFor(attempt, draftsBySession.get(attempt.sessionId)));
      events.push({ type: "unknown", sessionId: attempt.sessionId, requestId: attempt.requestId });
    }

    let prunedAttempts = 0;
    const pruned = await this.dependencies.attempts.prune(
      this.dependencies.retentionPolicy ?? DEFAULT_PROMPT_ATTEMPT_RETENTION_POLICY,
    );
    if (pruned.ok) {
      prunedAttempts = pruned.value;
    } else {
      events.push({ type: "failed", code: "attempt-prune-failed" });
    }
    return this.report(attemptsResult.value.length, issues, events, prunedAttempts);
  }

  private report(
    scannedAttempts: number,
    issues: readonly PromptRecoveryIssueRecord[],
    events: readonly PromptAttemptReconciliationEvent[],
    prunedAttempts = 0,
  ): PromptAttemptReconciliationReport {
    return { scannedAttempts, issues, events, prunedAttempts };
  }
}
