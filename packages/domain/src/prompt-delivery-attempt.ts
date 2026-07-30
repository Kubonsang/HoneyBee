import { z } from "zod";

import { DomainError } from "./errors.js";
import { SessionIdSchema } from "./ids.js";
import { PromptContentDigestSchema } from "./prompt-delivery-receipt.js";
import { err, ok, type Result } from "./result.js";
import { IsoDateTimeSchema } from "./session.js";

/** Strict durable phases for one Prompt dispatch Attempt. */
export const PromptDeliveryAttemptPhaseSchema = z.enum([
  "prepared",
  "dispatching",
  "runtime-accepted",
  "unknown",
  "cancelled-before-dispatch",
  "resolved-assumed-delivered",
  "resolved-retried",
]);
export type PromptDeliveryAttemptPhase = z.infer<typeof PromptDeliveryAttemptPhaseSchema>;

const terminalPhases = new Set<PromptDeliveryAttemptPhase>([
  "cancelled-before-dispatch",
  "resolved-assumed-delivered",
  "resolved-retried",
]);

/**
 * Content-minimized journal entry persisted before one Runtime input request.
 * Prompt content is intentionally excluded.
 */
export const PromptDeliveryAttemptSchema = z
  .object({
    requestId: z.string().trim().min(1).max(256),
    sessionId: SessionIdSchema,
    contentDigest: PromptContentDigestSchema,
    contentLength: z.number().int().nonnegative(),
    phase: PromptDeliveryAttemptPhaseSchema,
    preparedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    acceptedAt: IsoDateTimeSchema.optional(),
    resolvedAt: IsoDateTimeSchema.optional(),
    replacementRequestId: z.string().trim().min(1).max(256).optional(),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((attempt, context) => {
    const runtimeAccepted = attempt.phase === "runtime-accepted";
    const terminal = terminalPhases.has(attempt.phase);
    const retried = attempt.phase === "resolved-retried";

    if (runtimeAccepted !== (attempt.acceptedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "acceptedAt is required only for runtime-accepted Attempts.",
        path: ["acceptedAt"],
      });
    }
    if (terminal !== (attempt.resolvedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "resolvedAt is required only for terminal Attempts.",
        path: ["resolvedAt"],
      });
    }
    if (retried !== (attempt.replacementRequestId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "replacementRequestId is required only for resolved-retried Attempts.",
        path: ["replacementRequestId"],
      });
    }
    if (attempt.replacementRequestId === attempt.requestId) {
      context.addIssue({
        code: "custom",
        message: "A replacement request ID must differ from the original request ID.",
        path: ["replacementRequestId"],
      });
    }
  });

/** Durable, content-minimized evidence about one Prompt dispatch attempt. */
export type PromptDeliveryAttempt = z.infer<typeof PromptDeliveryAttemptSchema>;

/** Allowed phase-change payloads; identity fields are intentionally absent. */
export type PromptDeliveryAttemptTransition =
  | { readonly phase: "dispatching" | "unknown"; readonly updatedAt: string }
  | {
      readonly phase: "runtime-accepted";
      readonly updatedAt: string;
      readonly acceptedAt: string;
    }
  | {
      readonly phase: "cancelled-before-dispatch" | "resolved-assumed-delivered";
      readonly updatedAt: string;
      readonly resolvedAt: string;
    }
  | {
      readonly phase: "resolved-retried";
      readonly updatedAt: string;
      readonly resolvedAt: string;
      readonly replacementRequestId: string;
    };

const allowedTransitions: Readonly<
  Record<PromptDeliveryAttemptPhase, ReadonlySet<PromptDeliveryAttemptPhase>>
> = {
  prepared: new Set(["dispatching", "cancelled-before-dispatch"]),
  dispatching: new Set(["runtime-accepted", "unknown"]),
  "runtime-accepted": new Set(),
  unknown: new Set(["resolved-assumed-delivered", "resolved-retried"]),
  "cancelled-before-dispatch": new Set(),
  "resolved-assumed-delivered": new Set(),
  "resolved-retried": new Set(),
};

export const hasSamePromptAttemptIdentity = (
  left: PromptDeliveryAttempt,
  right: PromptDeliveryAttempt,
): boolean =>
  left.requestId === right.requestId &&
  left.sessionId === right.sessionId &&
  left.contentDigest === right.contentDigest &&
  left.contentLength === right.contentLength &&
  left.preparedAt === right.preparedAt &&
  left.schemaVersion === right.schemaVersion;

/** Applies one allowed monotonic Attempt phase transition. */
export const transitionPromptDeliveryAttempt = (
  attempt: PromptDeliveryAttempt,
  transition: PromptDeliveryAttemptTransition,
): Result<PromptDeliveryAttempt, DomainError> => {
  if (!allowedTransitions[attempt.phase].has(transition.phase)) {
    return err(
      new DomainError(
        "attempt-transition-conflict",
        `Prompt Attempt cannot transition from ${attempt.phase} to ${transition.phase}.`,
      ),
    );
  }

  const candidate = PromptDeliveryAttemptSchema.safeParse({
    requestId: attempt.requestId,
    sessionId: attempt.sessionId,
    contentDigest: attempt.contentDigest,
    contentLength: attempt.contentLength,
    phase: transition.phase,
    preparedAt: attempt.preparedAt,
    updatedAt: transition.updatedAt,
    ...("acceptedAt" in transition ? { acceptedAt: transition.acceptedAt } : {}),
    ...("resolvedAt" in transition ? { resolvedAt: transition.resolvedAt } : {}),
    ...("replacementRequestId" in transition
      ? { replacementRequestId: transition.replacementRequestId }
      : {}),
    schemaVersion: attempt.schemaVersion,
  });
  return candidate.success
    ? ok(candidate.data)
    : err(
        new DomainError("attempt-transition-conflict", "Prompt Attempt transition is invalid.", {
          issues: candidate.error.issues,
        }),
      );
};

const transitionForCandidate = (
  candidate: PromptDeliveryAttempt,
): PromptDeliveryAttemptTransition | undefined => {
  switch (candidate.phase) {
    case "prepared":
      return undefined;
    case "dispatching":
    case "unknown":
      return { phase: candidate.phase, updatedAt: candidate.updatedAt };
    case "runtime-accepted":
      return candidate.acceptedAt === undefined
        ? undefined
        : {
            phase: candidate.phase,
            updatedAt: candidate.updatedAt,
            acceptedAt: candidate.acceptedAt,
          };
    case "cancelled-before-dispatch":
    case "resolved-assumed-delivered":
      return candidate.resolvedAt === undefined
        ? undefined
        : {
            phase: candidate.phase,
            updatedAt: candidate.updatedAt,
            resolvedAt: candidate.resolvedAt,
          };
    case "resolved-retried":
      return candidate.resolvedAt === undefined || candidate.replacementRequestId === undefined
        ? undefined
        : {
            phase: candidate.phase,
            updatedAt: candidate.updatedAt,
            resolvedAt: candidate.resolvedAt,
            replacementRequestId: candidate.replacementRequestId,
          };
  }
};

/** Validates identity preservation and one idempotent or monotonic phase save. */
export const isValidPromptDeliveryAttemptSuccessor = (
  existing: PromptDeliveryAttempt,
  candidate: PromptDeliveryAttempt,
): boolean => {
  if (!hasSamePromptAttemptIdentity(existing, candidate)) {
    return false;
  }
  if (existing.phase === candidate.phase) {
    return JSON.stringify(existing) === JSON.stringify(candidate);
  }
  const transition = transitionForCandidate(candidate);
  if (transition === undefined) {
    return false;
  }
  const transitioned = transitionPromptDeliveryAttempt(existing, transition);
  return transitioned.ok && JSON.stringify(transitioned.value) === JSON.stringify(candidate);
};
export const isTerminalPromptDeliveryAttempt = (attempt: PromptDeliveryAttempt): boolean =>
  terminalPhases.has(attempt.phase);
