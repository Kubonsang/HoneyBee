import type { ConsoleRunListItem, ConsoleRunReplayState } from "./contracts.js";

export interface ReplayPresentation {
  readonly state: ConsoleRunReplayState;
  readonly statusText: string;
  readonly details: string;
  readonly degraded: boolean;
  readonly placeholder: string | undefined;
}

const reasonLabels: Readonly<Record<string, string>> = {
  "user-stop": "user stop",
  "process-exit-zero": "exit 0",
  "process-exit-nonzero": "non-zero exit",
  "extension-shutdown": "extension shutdown",
  "runtime-shutdown": "runtime shutdown",
  "runtime-disconnected": "runtime disconnected",
  "recovered-stale-run": "recovered stale Run",
  "start-failed": "start failed",
  "shutdown-timeout": "shutdown timeout",
};

export const runOutcomeLabel = (run: ConsoleRunListItem): string => {
  if (run.active) return run.phase.replaceAll("-", " ");
  if (run.exitCode !== undefined && run.exitCode !== null) {
    return run.exitCode === 0 ? "completed · exit 0" : "failed · exit " + String(run.exitCode);
  }
  const reason = run.terminationReason;
  if (run.phase === "interrupted") {
    return "interrupted" + (reason === undefined ? "" : " · " + (reasonLabels[reason] ?? reason));
  }
  if (reason === "user-stop" || reason === "extension-shutdown" || reason === "runtime-shutdown") {
    return "stopped · " + (reasonLabels[reason] ?? reason);
  }
  if (reason === "start-failed" || reason === "process-exit-nonzero") {
    return "failed · " + (reasonLabels[reason] ?? reason);
  }
  return "ended" + (reason === undefined ? "" : " · " + (reasonLabels[reason] ?? reason));
};

export const formatRunOption = (
  run: ConsoleRunListItem,
  formatTime: (isoDateTime: string) => string = (value) =>
    new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): string =>
  (run.active ? "Live · " : "") +
  "Run " +
  run.runId.slice(0, 8) +
  " · " +
  runOutcomeLabel(run) +
  " · " +
  formatTime(run.startedAt);

export const effectiveReplayState = (
  run: ConsoleRunListItem,
  surfaceRetained: boolean,
): ConsoleRunReplayState =>
  surfaceRetained &&
  (run.replayState === "metadata-only" || run.replayState === "retained-truncated")
    ? "surface-only"
    : run.replayState;

const retainedRange = (run: ConsoleRunListItem): string =>
  run.truncatedBytes === 0
    ? ""
    : " " + run.truncatedBytes.toLocaleString() + " earlier UTF-8 bytes were truncated.";

export const replayPresentation = (
  run: ConsoleRunListItem,
  surfaceRetained: boolean,
): ReplayPresentation => {
  const state = effectiveReplayState(run, surfaceRetained);
  if (run.sequenceGap) {
    return {
      state: "sequence-gap",
      statusText: "Sequence gap · reconstructed screen may be inconsistent",
      details:
        "One or more terminal output events were missed. Raw ANSI replay cannot manufacture the missing bytes." +
        retainedRange(run),
      degraded: true,
      placeholder: undefined,
    };
  }
  switch (state) {
    case "live":
      return {
        state,
        statusText: "Live terminal",
        details: "This is the current interactive Runtime Run.",
        degraded: false,
        placeholder: undefined,
      };
    case "surface-only":
      return {
        state,
        statusText: "Retained terminal surface · read only",
        details:
          "The live emulator surface is still available in this Webview, but its transcript is no longer retained for reconstruction after reload.",
        degraded: false,
        placeholder: undefined,
      };
    case "retained-complete":
      return {
        state,
        statusText: "Retained replay · read only",
        details:
          "Replayed from the complete retained in-memory transcript. Raw ANSI replay is not a serialized emulator snapshot.",
        degraded: false,
        placeholder: undefined,
      };
    case "retained-truncated":
      return {
        state,
        statusText: "Truncated replay · screen may be incomplete",
        details:
          "Earlier terminal output was evicted from memory. Raw ANSI replay is not an emulator snapshot." +
          retainedRange(run),
        degraded: true,
        placeholder: undefined,
      };
    case "sequence-gap":
      throw new Error("Sequence gaps are handled before replay state dispatch.");
    case "metadata-only":
      return {
        state,
        statusText: "Terminal screen unavailable · metadata only",
        details:
          "Honey Bee retains Run metadata separately from terminal output. Terminal bodies are not persisted in globalState.",
        degraded: true,
        placeholder:
          "This Run's terminal screen is no longer retained in memory. Open its log if recorded output is available.",
      };
  }
};

export const runSelectionAnnouncement = (
  run: ConsoleRunListItem,
  presentation: ReplayPresentation,
): string => {
  const mode = run.active ? "Live." : "Read only.";
  return (
    "Viewing " +
    runOutcomeLabel(run) +
    " Run " +
    run.runId.slice(0, 8) +
    ". " +
    mode +
    " " +
    presentation.statusText +
    "."
  );
};
