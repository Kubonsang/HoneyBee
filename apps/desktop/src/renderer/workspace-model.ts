import type { RunDetailV1, RunSummaryV1 } from "@honeybee/control-plane-contracts";

export const WORK_STAGES = ["Brief", "Build", "Test", "Review"] as const;

export const runStage = (run: RunSummaryV1 | undefined): number => {
  if (run === undefined) return 0;
  const phase = run.phase.toLowerCase();
  if (
    run.status.toLowerCase() === "completed" ||
    phase.includes("verify") ||
    phase.includes("evidence")
  ) {
    return 3;
  }
  if (phase.includes("test") || phase.includes("warm") || phase.includes("compile")) return 2;
  if (
    phase.includes("agent") ||
    phase.includes("work") ||
    phase.includes("workspace") ||
    phase.includes("editor")
  ) {
    return 1;
  }
  return 0;
};

export const runTitle = (run: RunSummaryV1 | undefined): string => {
  const value = run?.workId ?? run?.mode ?? "New Work";
  return value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
};

export const runNeedsAttention = (run: RunSummaryV1): boolean => {
  const status = run.status.toLowerCase();
  return (
    status.includes("fail") ||
    status.includes("indeterminate") ||
    status.includes("cleanup") ||
    status.includes("cancel")
  );
};

export const capabilityToggleDisabled = (testplayAvailable: boolean, checked: boolean): boolean =>
  !testplayAvailable && !checked;

export const runEvidenceSummary = (detail: RunDetailV1 | undefined): string => {
  if (detail === undefined) return "Reading durable Run evidence…";
  const summaries = detail.events.map((event) => event.summary.toLowerCase());
  const compile = summaries.some((summary) => summary.includes("compile"));
  const warmTest = summaries.some(
    (summary) => summary.includes("warm") || summary.includes("test"),
  );
  return [
    compile ? "Compile observed" : undefined,
    warmTest ? "Test evidence observed" : undefined,
    detail.artifacts.length > 0
      ? `${detail.artifacts.length} Artifact${detail.artifacts.length === 1 ? "" : "s"}`
      : "No readable Artifacts yet",
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
};
