import type { RunId, SessionRunRecord } from "@honeybee/domain";
import type {
  ConsoleRunListItem,
  ConsoleRunReplayState,
  ConsoleRunSummary,
} from "@honeybee/ui-shared";

import type { RunOutputSnapshot } from "./run-output-buffer-store.js";

export const MAX_CONSOLE_RUN_METADATA = 50;

export interface ConsoleRunAvailability {
  readonly transcript: RunOutputSnapshot | undefined;
  readonly logAvailable: boolean;
}

export interface ConsoleRunProjection {
  readonly activeRun: ConsoleRunSummary | null;
  readonly viewedRun: ConsoleRunSummary | null;
  readonly availableRuns: readonly ConsoleRunListItem[];
}

const phaseForRun = (run: SessionRunRecord): ConsoleRunSummary["phase"] => {
  switch (run.phase) {
    case "starting":
    case "running":
    case "waiting-for-input":
    case "stopping":
      return run.phase;
    case "interrupted":
      return "interrupted";
    case "stopped":
    case "completed":
    case "failed":
      return "ended";
  }
};

export const consoleRunSummary = (run: SessionRunRecord, active: boolean): ConsoleRunSummary => ({
  runId: run.runId,
  sessionId: run.sessionId,
  phase: phaseForRun(run),
  interactive: active && (run.phase === "running" || run.phase === "waiting-for-input"),
  startedAt: run.startedAt,
  ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
  ...(run.terminationReason === undefined ? {} : { terminationReason: run.terminationReason }),
  ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
});

const replayState = (
  active: boolean,
  transcript: RunOutputSnapshot | undefined,
): ConsoleRunReplayState => {
  if (active) return "live";
  if (transcript === undefined) return "metadata-only";
  if (transcript.sequenceGap) return "sequence-gap";
  return transcript.truncatedBytes > 0 ? "retained-truncated" : "retained-complete";
};

const compareRuns = (
  left: SessionRunRecord,
  right: SessionRunRecord,
  activeRunId: RunId | undefined,
): number => {
  if (left.runId === activeRunId) return right.runId === activeRunId ? 0 : -1;
  if (right.runId === activeRunId) return 1;
  return right.startedAt.localeCompare(left.startedAt) || left.runId.localeCompare(right.runId);
};

const retainRequiredRuns = (
  sorted: readonly SessionRunRecord[],
  requiredIds: ReadonlySet<RunId>,
  limit: number,
): SessionRunRecord[] => {
  const retained = sorted.slice(0, Math.max(limit, requiredIds.size));
  const retainedIds = new Set(retained.map((run) => run.runId));
  for (const requiredId of requiredIds) {
    if (retainedIds.has(requiredId)) continue;
    const required = sorted.find((run) => run.runId === requiredId);
    if (required === undefined) continue;
    let replaceAt = -1;
    for (let index = retained.length - 1; index >= 0; index -= 1) {
      const candidate = retained[index];
      if (candidate !== undefined && !requiredIds.has(candidate.runId)) {
        replaceAt = index;
        break;
      }
    }
    if (replaceAt < 0) continue;
    const replaced = retained[replaceAt];
    if (replaced !== undefined) retainedIds.delete(replaced.runId);
    retained[replaceAt] = required;
    retainedIds.add(required.runId);
  }
  return retained;
};

/** Projects bounded, content-free Run navigation state from durable metadata and memory availability. */
export const projectConsoleRuns = (
  runs: readonly SessionRunRecord[],
  activeRunId: RunId | undefined,
  viewedRunId: RunId | undefined,
  availability: (run: SessionRunRecord) => ConsoleRunAvailability,
  limit = MAX_CONSOLE_RUN_METADATA,
): ConsoleRunProjection => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Run metadata limit must be a positive safe integer.");
  }
  const unique = new Map<RunId, SessionRunRecord>();
  for (const run of runs) {
    if (unique.has(run.runId)) throw new Error("Run metadata contains a duplicate Run ID.");
    unique.set(run.runId, run);
  }
  const sorted = [...unique.values()].sort((left, right) => compareRuns(left, right, activeRunId));
  const requiredIds = new Set<RunId>();
  if (activeRunId !== undefined) requiredIds.add(activeRunId);
  if (viewedRunId !== undefined) requiredIds.add(viewedRunId);
  const retained = retainRequiredRuns(sorted, requiredIds, limit).sort((left, right) =>
    compareRuns(left, right, activeRunId),
  );
  const active = activeRunId === undefined ? undefined : unique.get(activeRunId);
  const viewed = viewedRunId === undefined ? undefined : unique.get(viewedRunId);
  return {
    activeRun: active === undefined ? null : consoleRunSummary(active, true),
    viewedRun:
      viewed === undefined ? null : consoleRunSummary(viewed, viewed.runId === activeRunId),
    availableRuns: retained.map((run) => {
      const activeItem = run.runId === activeRunId;
      const details = availability(run);
      const transcript = details.transcript;
      return {
        ...consoleRunSummary(run, activeItem),
        active: activeItem,
        viewed: run.runId === viewedRunId,
        replayState: replayState(activeItem, transcript),
        truncatedBytes: transcript?.truncatedBytes ?? 0,
        sequenceGap: transcript?.sequenceGap ?? false,
        logAvailable: details.logAvailable,
      };
    }),
  };
};
