import { z } from "zod";

import { DomainError } from "./errors.js";
import { RunIdSchema, RuntimeInstanceIdSchema, SessionIdSchema } from "./ids.js";
import { err, ok, type Result } from "./result.js";
import { IsoDateTimeSchema } from "./session.js";

/** Monotonic lifecycle phases for one concrete Agent process run. */
export const SessionRunPhaseSchema = z.enum([
  "starting",
  "running",
  "waiting-for-input",
  "stopping",
  "stopped",
  "completed",
  "failed",
  "interrupted",
]);
export type SessionRunPhase = z.infer<typeof SessionRunPhaseSchema>;

/** Content-free reason why a Session run reached a terminal phase. */
export const SessionTerminationReasonSchema = z.enum([
  "user-stop",
  "process-exit-zero",
  "process-exit-nonzero",
  "extension-shutdown",
  "runtime-shutdown",
  "runtime-disconnected",
  "recovered-stale-run",
  "start-failed",
  "shutdown-timeout",
]);
export type SessionTerminationReason = z.infer<typeof SessionTerminationReasonSchema>;

const terminalPhases = new Set<SessionRunPhase>(["stopped", "completed", "failed", "interrupted"]);

const reasonPhases: Readonly<Record<SessionTerminationReason, ReadonlySet<SessionRunPhase>>> = {
  "user-stop": new Set(["stopped"]),
  "process-exit-zero": new Set(["completed"]),
  "process-exit-nonzero": new Set(["failed"]),
  "extension-shutdown": new Set(["stopped"]),
  "runtime-shutdown": new Set(["stopped"]),
  "runtime-disconnected": new Set(["interrupted"]),
  "recovered-stale-run": new Set(["interrupted"]),
  "start-failed": new Set(["failed"]),
  "shutdown-timeout": new Set(["interrupted"]),
};

/**
 * Durable identity and latest lifecycle state for one Agent process run.
 * Prompt content, terminal output, environment and launch arguments are excluded.
 */
export const SessionRunRecordSchema = z
  .object({
    runId: RunIdSchema,
    sessionId: SessionIdSchema,
    runtimeInstanceId: RuntimeInstanceIdSchema,
    phase: SessionRunPhaseSchema,
    startedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.optional(),
    terminationReason: SessionTerminationReasonSchema.optional(),
    exitCode: z.number().int().optional(),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((run, context) => {
    const terminal = terminalPhases.has(run.phase);
    if (terminal !== (run.endedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "endedAt is required only for terminal Session Runs.",
        path: ["endedAt"],
      });
    }
    if (terminal !== (run.terminationReason !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "terminationReason is required only for terminal Session Runs.",
        path: ["terminationReason"],
      });
    }
    if (
      run.terminationReason !== undefined &&
      !reasonPhases[run.terminationReason].has(run.phase)
    ) {
      context.addIssue({
        code: "custom",
        message: "terminationReason is incompatible with the Session Run phase.",
        path: ["terminationReason"],
      });
    }
    if (!terminal && run.exitCode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "exitCode is allowed only for terminal Session Runs.",
        path: ["exitCode"],
      });
    }
    if (run.terminationReason === "process-exit-zero" && run.exitCode !== 0) {
      context.addIssue({
        code: "custom",
        message: "process-exit-zero requires exitCode 0.",
        path: ["exitCode"],
      });
    }
    if (run.terminationReason === "process-exit-nonzero" && run.exitCode === 0) {
      context.addIssue({
        code: "custom",
        message: "process-exit-nonzero rejects exitCode 0.",
        path: ["exitCode"],
      });
    }
  });

/** Durable lifecycle state for one correlated Runtime run. */
export type SessionRunRecord = z.infer<typeof SessionRunRecordSchema>;

export type SessionRunTransition =
  | { readonly phase: "running" | "waiting-for-input" | "stopping"; readonly updatedAt: string }
  | {
      readonly phase: "stopped" | "completed" | "failed" | "interrupted";
      readonly updatedAt: string;
      readonly endedAt: string;
      readonly terminationReason: SessionTerminationReason;
      readonly exitCode?: number;
    };

const allowedTransitions: Readonly<Record<SessionRunPhase, ReadonlySet<SessionRunPhase>>> = {
  starting: new Set(["running", "stopping", "failed", "interrupted"]),
  running: new Set(["waiting-for-input", "stopping", "completed", "failed", "interrupted"]),
  "waiting-for-input": new Set(["running", "stopping", "completed", "failed", "interrupted"]),
  stopping: new Set(["stopped", "completed", "failed", "interrupted"]),
  stopped: new Set(),
  completed: new Set(),
  failed: new Set(),
  interrupted: new Set(),
};

export const isActiveSessionRun = (run: SessionRunRecord): boolean =>
  !terminalPhases.has(run.phase);

export const hasSameSessionRunIdentity = (
  left: SessionRunRecord,
  right: SessionRunRecord,
): boolean =>
  left.runId === right.runId &&
  left.sessionId === right.sessionId &&
  left.runtimeInstanceId === right.runtimeInstanceId &&
  left.startedAt === right.startedAt &&
  left.schemaVersion === right.schemaVersion;

/** Applies one allowed forward-only lifecycle transition. */
export const transitionSessionRun = (
  run: SessionRunRecord,
  transition: SessionRunTransition,
): Result<SessionRunRecord, DomainError> => {
  if (!allowedTransitions[run.phase].has(transition.phase)) {
    return err(
      new DomainError(
        "session-run-transition-conflict",
        `Session Run cannot transition from ${run.phase} to ${transition.phase}.`,
      ),
    );
  }
  const candidate = SessionRunRecordSchema.safeParse({
    runId: run.runId,
    sessionId: run.sessionId,
    runtimeInstanceId: run.runtimeInstanceId,
    phase: transition.phase,
    startedAt: run.startedAt,
    updatedAt: transition.updatedAt,
    ...("endedAt" in transition
      ? {
          endedAt: transition.endedAt,
          terminationReason: transition.terminationReason,
          ...(transition.exitCode === undefined ? {} : { exitCode: transition.exitCode }),
        }
      : {}),
    schemaVersion: run.schemaVersion,
  });
  return candidate.success
    ? ok(candidate.data)
    : err(
        new DomainError("session-run-transition-conflict", "Session Run transition is invalid.", {
          issues: candidate.error.issues,
        }),
      );
};

const transitionForCandidate = (candidate: SessionRunRecord): SessionRunTransition | undefined => {
  if (
    candidate.phase === "running" ||
    candidate.phase === "waiting-for-input" ||
    candidate.phase === "stopping"
  ) {
    return { phase: candidate.phase, updatedAt: candidate.updatedAt };
  }
  if (
    candidate.phase === "stopped" ||
    candidate.phase === "completed" ||
    candidate.phase === "failed" ||
    candidate.phase === "interrupted"
  ) {
    if (candidate.endedAt === undefined || candidate.terminationReason === undefined) {
      return undefined;
    }
    return {
      phase: candidate.phase,
      updatedAt: candidate.updatedAt,
      endedAt: candidate.endedAt,
      terminationReason: candidate.terminationReason,
      ...(candidate.exitCode === undefined ? {} : { exitCode: candidate.exitCode }),
    };
  }
  return undefined;
};

/** Validates identity preservation and an idempotent or allowed monotonic save. */
export const isValidSessionRunSuccessor = (
  existing: SessionRunRecord,
  candidate: SessionRunRecord,
): boolean => {
  if (!hasSameSessionRunIdentity(existing, candidate)) return false;
  if (existing.phase === candidate.phase) {
    return JSON.stringify(existing) === JSON.stringify(candidate);
  }
  const transition = transitionForCandidate(candidate);
  if (transition === undefined) return false;
  const transitioned = transitionSessionRun(existing, transition);
  return transitioned.ok && JSON.stringify(transitioned.value) === JSON.stringify(candidate);
};
