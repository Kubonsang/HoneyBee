import {
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
  type SessionDraft,
  type SessionId,
} from "@honeybee/domain";
import type {
  DraftRepository,
  PromptDeliveryAttemptRepository,
  PromptDeliveryReceiptRepository,
} from "@honeybee/persistence";

import { deliverPrompt, type PromptDeliveryResult } from "./prompt-delivery.js";
import type { PromptRecoveryIssueRecord } from "./prompt-delivery-attempt-reconciler.js";
import { receiptMatchesPromptContent } from "./prompt-content-fingerprint.js";
import type { ClockPort, IdGeneratorPort, RuntimeClientPort } from "./ports.js";

export type PromptRecoveryActionResult =
  | { readonly status: "resolved"; readonly draftCleared: boolean }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly code: "attempt-recovery-action-failed" }
  | {
      readonly status: "retry-finished";
      readonly replacementRequestId: string;
      readonly delivery: PromptDeliveryResult;
    };

export interface PromptRecoveryServiceDependencies {
  readonly attempts: PromptDeliveryAttemptRepository;
  readonly drafts: DraftRepository;
  readonly receipts: PromptDeliveryReceiptRepository;
  readonly runtime: RuntimeClientPort;
  readonly clock: ClockPort;
  readonly ids: Pick<IdGeneratorPort, "requestId">;
  readonly initialIssues?: readonly PromptRecoveryIssueRecord[];
}

const draftMatch = (
  attempt: PromptDeliveryAttempt,
  draft: SessionDraft | undefined,
): PromptRecoveryIssueRecord["draftMatch"] => {
  if (draft === undefined) return "missing";
  const notNewer = Date.parse(draft.updatedAt) <= Date.parse(attempt.updatedAt);
  return notNewer && receiptMatchesPromptContent(attempt, draft.content) ? "exact" : "different";
};

/** Owns unresolved unknown outcomes and explicit, Session-isolated user resolution. */
export class PromptRecoveryService {
  readonly #issues = new Map<SessionId, Map<string, PromptRecoveryIssueRecord>>();
  readonly #activeActions = new Map<SessionId, Promise<PromptRecoveryActionResult>>();

  public constructor(private readonly dependencies: PromptRecoveryServiceDependencies) {
    for (const issue of dependencies.initialIssues ?? []) this.addIssue(issue);
  }

  public issueFor(sessionId: SessionId): PromptRecoveryIssueRecord | undefined {
    return this.#issues.get(sessionId)?.values().next().value;
  }

  public async registerUnknown(requestId: string, sessionId: SessionId): Promise<void> {
    const [attempt, draftResult] = await Promise.all([
      this.unknownAttempt(requestId, sessionId),
      this.dependencies.drafts.getBySessionId(sessionId),
    ]);
    if (attempt === undefined) {
      this.addIssue({
        requestId,
        sessionId,
        outcome: "unknown",
        draftMatch: draftResult.ok && draftResult.value === undefined ? "missing" : "different",
        occurredAt: this.dependencies.clock.now(),
      });
      return;
    }
    this.addIssue({
      requestId,
      sessionId,
      outcome: "unknown",
      draftMatch: draftMatch(attempt, draftResult.ok ? draftResult.value : undefined),
      occurredAt: attempt.updatedAt,
    });
  }

  public async refreshDraftMatch(sessionId: SessionId): Promise<void> {
    const issues = [...(this.#issues.get(sessionId)?.values() ?? [])];
    if (issues.length === 0) return;
    const draftResult = await this.dependencies.drafts.getBySessionId(sessionId);
    if (!draftResult.ok) return;
    for (const issue of issues) {
      const attempt = await this.unknownAttempt(issue.requestId, sessionId);
      if (attempt === undefined) continue;
      this.addIssue({
        ...issue,
        draftMatch: draftMatch(attempt, draftResult.value),
      });
    }
  }

  public assumeDelivered(
    requestId: string,
    sessionId: SessionId,
  ): Promise<PromptRecoveryActionResult> {
    return this.runAction(sessionId, () => this.assumeDeliveredOnce(requestId, sessionId));
  }

  public retry(requestId: string, sessionId: SessionId): Promise<PromptRecoveryActionResult> {
    return this.runAction(sessionId, () => this.retryOnce(requestId, sessionId));
  }

  private async assumeDeliveredOnce(
    requestId: string,
    sessionId: SessionId,
  ): Promise<PromptRecoveryActionResult> {
    const issue = this.issueFor(sessionId);
    if (issue?.requestId !== requestId) return { status: "ignored" };
    const attempt = await this.unknownAttempt(requestId, sessionId);
    if (attempt === undefined) return { status: "failed", code: "attempt-recovery-action-failed" };
    const draftResult = await this.dependencies.drafts.getBySessionId(sessionId);
    if (!draftResult.ok) return { status: "failed", code: "attempt-recovery-action-failed" };

    const exact = draftMatch(attempt, draftResult.value) === "exact";
    if (exact) {
      const deleted = await this.dependencies.drafts.delete(sessionId);
      if (!deleted.ok) return { status: "failed", code: "attempt-recovery-action-failed" };
    }

    const resolvedAt = this.dependencies.clock.now();
    const resolved = transitionPromptDeliveryAttempt(attempt, {
      phase: "resolved-assumed-delivered",
      updatedAt: resolvedAt,
      resolvedAt,
    });
    if (!resolved.ok) return { status: "failed", code: "attempt-recovery-action-failed" };
    const saved = await this.dependencies.attempts.save(resolved.value);
    if (!saved.ok) return { status: "failed", code: "attempt-recovery-action-failed" };
    this.removeIssue(sessionId, requestId);
    return { status: "resolved", draftCleared: exact };
  }

  private async retryOnce(
    requestId: string,
    sessionId: SessionId,
  ): Promise<PromptRecoveryActionResult> {
    const issue = this.issueFor(sessionId);
    if (issue?.requestId !== requestId) return { status: "ignored" };
    const attempt = await this.unknownAttempt(requestId, sessionId);
    if (attempt === undefined) return { status: "failed", code: "attempt-recovery-action-failed" };
    const draftResult = await this.dependencies.drafts.getBySessionId(sessionId);
    if (
      !draftResult.ok ||
      draftResult.value === undefined ||
      draftMatch(attempt, draftResult.value) !== "exact"
    ) {
      return { status: "failed", code: "attempt-recovery-action-failed" };
    }

    const replacementRequestId = this.dependencies.ids.requestId();
    if (replacementRequestId === requestId) {
      return { status: "failed", code: "attempt-recovery-action-failed" };
    }
    const delivery = await deliverPrompt(
      {
        drafts: this.dependencies.drafts,
        attempts: this.dependencies.attempts,
        receipts: this.dependencies.receipts,
        runtime: this.dependencies.runtime,
        clock: this.dependencies.clock,
      },
      replacementRequestId,
      sessionId,
      draftResult.value.content,
    );
    if (delivery.status === "accepted") {
      const resolvedAt = this.dependencies.clock.now();
      const resolved = transitionPromptDeliveryAttempt(attempt, {
        phase: "resolved-retried",
        updatedAt: resolvedAt,
        resolvedAt,
        replacementRequestId,
      });
      if (!resolved.ok) return { status: "failed", code: "attempt-recovery-action-failed" };
      const saved = await this.dependencies.attempts.save(resolved.value);
      if (!saved.ok) return { status: "failed", code: "attempt-recovery-action-failed" };
      this.removeIssue(sessionId, requestId);
    } else {
      if (delivery.status === "unknown") {
        await this.registerUnknown(replacementRequestId, sessionId);
      }
      await this.refreshDraftMatch(sessionId);
    }
    return { status: "retry-finished", replacementRequestId, delivery };
  }

  private runAction(
    sessionId: SessionId,
    operation: () => Promise<PromptRecoveryActionResult>,
  ): Promise<PromptRecoveryActionResult> {
    const existing = this.#activeActions.get(sessionId);
    if (existing !== undefined) return existing;
    const action = operation();
    this.#activeActions.set(sessionId, action);
    return action.finally(() => {
      if (this.#activeActions.get(sessionId) === action) this.#activeActions.delete(sessionId);
    });
  }

  private addIssue(issue: PromptRecoveryIssueRecord): void {
    let sessionIssues = this.#issues.get(issue.sessionId);
    if (sessionIssues === undefined) {
      sessionIssues = new Map<string, PromptRecoveryIssueRecord>();
      this.#issues.set(issue.sessionId, sessionIssues);
    }
    sessionIssues.set(issue.requestId, issue);
  }

  private removeIssue(sessionId: SessionId, requestId: string): void {
    const sessionIssues = this.#issues.get(sessionId);
    if (sessionIssues === undefined) return;
    sessionIssues.delete(requestId);
    if (sessionIssues.size === 0) this.#issues.delete(sessionId);
  }

  private async unknownAttempt(
    requestId: string,
    sessionId: SessionId,
  ): Promise<PromptDeliveryAttempt | undefined> {
    const result = await this.dependencies.attempts.getByRequestId(requestId);
    if (!result.ok || result.value?.sessionId !== sessionId) return undefined;
    if (result.value.phase === "unknown") return result.value;
    if (result.value.phase !== "dispatching") return undefined;
    const transitioned = transitionPromptDeliveryAttempt(result.value, {
      phase: "unknown",
      updatedAt: result.value.updatedAt,
    });
    if (!transitioned.ok) return undefined;
    const saved = await this.dependencies.attempts.save(transitioned.value);
    return saved.ok ? saved.value : undefined;
  }
}
