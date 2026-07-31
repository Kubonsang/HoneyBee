import { describe, expect, it } from "vitest";

import type { ConsoleRunListItem } from "./contracts.js";
import {
  effectiveReplayState,
  formatRunOption,
  replayPresentation,
  runOutcomeLabel,
  runSelectionAnnouncement,
} from "./run-selector-model.js";

const item = (overrides: Partial<ConsoleRunListItem> = {}): ConsoleRunListItem => ({
  runId: "7f2a1234-full",
  sessionId: "session-1",
  phase: "ended",
  interactive: false,
  startedAt: "2026-07-31T13:41:00.000Z",
  endedAt: "2026-07-31T13:42:00.000Z",
  terminationReason: "process-exit-zero",
  exitCode: 0,
  active: false,
  viewed: true,
  replayState: "retained-complete",
  truncatedBytes: 0,
  sequenceGap: false,
  logAvailable: false,
  ...overrides,
});

describe("Run selector presentation", () => {
  it("formats a content-free option and human termination outcome", () => {
    const run = item();
    expect(runOutcomeLabel(run)).toBe("completed · exit 0");
    expect(formatRunOption(run, () => "22:41")).toBe("Run 7f2a1234 · completed · exit 0 · 22:41");
    expect(formatRunOption(run, () => "22:41")).not.toContain("session-1");
  });

  it("distinguishes retained, truncated, gap, metadata-only and surface-only states", () => {
    expect(replayPresentation(item(), false)).toMatchObject({
      state: "retained-complete",
      degraded: false,
    });
    expect(
      replayPresentation(
        item({ replayState: "retained-truncated", truncatedBytes: 49_152 }),
        false,
      ),
    ).toMatchObject({ state: "retained-truncated", degraded: true });
    expect(
      replayPresentation(item({ replayState: "sequence-gap", sequenceGap: true }), false),
    ).toMatchObject({ state: "sequence-gap", degraded: true });
    const metadata = item({ replayState: "metadata-only" });
    expect(replayPresentation(metadata, false)).toMatchObject({
      state: "metadata-only",
      degraded: true,
      placeholder: expect.stringContaining("no longer retained"),
    });
    expect(effectiveReplayState(metadata, true)).toBe("surface-only");
    expect(
      effectiveReplayState(item({ replayState: "retained-truncated", truncatedBytes: 256 }), true),
    ).toBe("surface-only");
    expect(replayPresentation(metadata, true)).toMatchObject({
      state: "surface-only",
      degraded: false,
    });
  });

  it("announces live/read-only and replay completeness without terminal content", () => {
    const run = item({ replayState: "retained-truncated", truncatedBytes: 128 });
    const announcement = runSelectionAnnouncement(run, replayPresentation(run, false));
    expect(announcement).toContain("Read only");
    expect(announcement).toContain("Truncated replay");
    expect(announcement).not.toContain("terminal output");
  });

  it("distinguishes stopped and failed termination reasons in user language", () => {
    expect(
      runOutcomeLabel(
        item({
          terminationReason: "user-stop",
          exitCode: null,
        }),
      ),
    ).toBe("stopped · user stop");
    expect(
      runOutcomeLabel(
        item({
          terminationReason: "start-failed",
          exitCode: null,
        }),
      ),
    ).toBe("failed · start failed");
  });
  it("maps interrupted reasons without treating every interruption as a failure", () => {
    expect(
      runOutcomeLabel(
        item({
          phase: "interrupted",
          terminationReason: "recovered-stale-run",
          exitCode: null,
        }),
      ),
    ).toBe("interrupted · recovered stale Run");
  });
});
