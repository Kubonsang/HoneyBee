import {
  transitionSessionRun,
  type AgentSession,
  type RunId,
  type SessionId,
  type SessionRunRecord,
} from "@honeybee/domain";
import type { SessionRepository, SessionRunRepository } from "@honeybee/persistence";

import type { ClockPort } from "./ports.js";
import { isPersistedActiveSessionStatus } from "./session-run-controller.js";

export type SessionRunReconciliationEvent =
  | {
      readonly type: "recovered";
      readonly sessionId: SessionId;
      readonly runId: RunId;
    }
  | {
      readonly type: "recovered-legacy-status";
      readonly sessionId: SessionId;
    }
  | {
      readonly type: "failed";
      readonly code:
        "session-list-failed" | "run-list-failed" | "session-save-failed" | "run-save-failed";
      readonly sessionId?: SessionId;
      readonly runId?: RunId;
    };

export interface SessionRunReconciliationReport {
  readonly recoveredRuns: number;
  readonly recoveredLegacySessions: number;
  readonly events: readonly SessionRunReconciliationEvent[];
}

/** Converts active state from a previous ephemeral Runtime generation into a safe terminal state. */
export class SessionRunReconciler {
  public constructor(
    private readonly sessions: SessionRepository,
    private readonly runs: SessionRunRepository,
    private readonly clock: ClockPort,
  ) {}

  public async reconcile(): Promise<SessionRunReconciliationReport> {
    const events: SessionRunReconciliationEvent[] = [];
    const [sessionsResult, runsResult] = await Promise.all([
      this.sessions.list(),
      this.runs.listActive(),
    ]);
    if (!sessionsResult.ok) {
      return {
        recoveredRuns: 0,
        recoveredLegacySessions: 0,
        events: [{ type: "failed", code: "session-list-failed" }],
      };
    }
    if (!runsResult.ok) {
      events.push({ type: "failed", code: "run-list-failed" });
    }

    const activeRuns = runsResult.ok ? runsResult.value : [];
    const sessionsById = new Map(sessionsResult.value.map((session) => [session.id, session]));
    const runSessionIds = new Set<SessionId>();
    let recoveredRuns = 0;
    for (const run of activeRuns) {
      runSessionIds.add(run.sessionId);
      const session = sessionsById.get(run.sessionId);
      if (session !== undefined && isPersistedActiveSessionStatus(session.status)) {
        const savedSession = await this.sessions.save({
          ...session,
          status: "stopped",
          updatedAt: this.clock.now(),
        });
        if (!savedSession.ok) {
          events.push({
            type: "failed",
            code: "session-save-failed",
            sessionId: run.sessionId,
            runId: run.runId,
          });
          continue;
        }
      }
      if (!(await this.interruptRun(run))) {
        events.push({
          type: "failed",
          code: "run-save-failed",
          sessionId: run.sessionId,
          runId: run.runId,
        });
        continue;
      }
      recoveredRuns += 1;
      events.push({ type: "recovered", sessionId: run.sessionId, runId: run.runId });
    }

    let recoveredLegacySessions = 0;
    for (const session of sessionsResult.value) {
      if (!isPersistedActiveSessionStatus(session.status) || runSessionIds.has(session.id))
        continue;
      const saved = await this.sessions.save({
        ...session,
        status: "stopped",
        updatedAt: this.clock.now(),
      });
      if (!saved.ok) {
        events.push({ type: "failed", code: "session-save-failed", sessionId: session.id });
        continue;
      }
      recoveredLegacySessions += 1;
      events.push({ type: "recovered-legacy-status", sessionId: session.id });
    }

    return { recoveredRuns, recoveredLegacySessions, events };
  }

  private async interruptRun(run: SessionRunRecord): Promise<boolean> {
    const now = this.clock.now();
    const interrupted = transitionSessionRun(run, {
      phase: "interrupted",
      updatedAt: now,
      endedAt: now,
      terminationReason: "recovered-stale-run",
    });
    if (!interrupted.ok) return false;
    const saved = await this.runs.save(interrupted.value);
    return saved.ok;
  }
}

export const sessionRunRecoveryMessage = (session: AgentSession): string =>
  `${session.title} was active when the previous Honey Bee Runtime ended. It was not restarted automatically.`;
