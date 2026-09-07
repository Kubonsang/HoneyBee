import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const input = process.argv[2];
if (input === undefined)
  throw new Error("Usage: node summarize-shared-cache.mjs <measurements.json>");
const records = JSON.parse((await readFile(input, "utf8")).replace(/^\uFEFF/, ""));
const warm = records.filter((record) => record.iteration > 0);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.some((n) => !Number.isFinite(n)))
    throw new Error("Missing or invalid measurements");
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const cases = (record) =>
  record.result.tests
    .map((test) => `${test.name}:${test.result}`)
    .sort()
    .join("\n");
const modes = {};
for (const mode of ["local", "shared-content"]) {
  const runs = warm.filter((record) => record.mode === mode);
  if (runs.length !== 10 || new Set(runs.map((record) => record.iteration)).size !== 10)
    throw new Error(`${mode}: expected ten distinct warm runs`);
  if (runs.some((record) => record.iteration < 1 || record.iteration > 10))
    throw new Error(`${mode}: iteration outside 1..10`);
  modes[mode] = {
    runs: runs.length,
    testsPassed: runs.reduce((sum, record) => sum + record.result.passed, 0),
    correct: runs.every(
      (record) =>
        record.exitCode === 0 &&
        record.result.exit_code === 0 &&
        record.result.total === 22 &&
        record.result.passed === 22 &&
        record.result.failed === 0 &&
        record.result.skipped === 0 &&
        record.result.tests.length === 22 &&
        record.result.backend === "shadow" &&
        record.result.workspace_metrics.workspaceBackend === "legacy" &&
        record.result.workspace_metrics.fallbackUsed === false &&
        (record.result.warnings ?? []).length === 0 &&
        cases(record) === cases(warm[0]),
    ),
    medianWallMs: median(runs.map((record) => record.wallMs)),
    medianPreparationMs: median(
      runs.map((record) => record.result.workspace_metrics.workspacePreparationMs),
    ),
    medianWriteBackMs: median(
      runs.map((record) => record.result.workspace_metrics.cacheWriteBackMs),
    ),
    peakAllocatedBytes: Math.max(
      ...runs.map((record) => record.result.workspace_metrics.observedPeakAdditionalPhysicalBytes),
    ),
  };
}
const local = modes.local;
const shared = modes["shared-content"];
const gates = {
  identicalSuccessfulTests: local.correct && shared.correct,
  medianTotalWithinTenPercent: shared.medianWallMs <= local.medianWallMs * 1.1,
  medianPreparationWithinTenPercent: shared.medianPreparationMs <= local.medianPreparationMs * 1.1,
  observedPeakDoesNotIncrease: shared.peakAllocatedBytes <= local.peakAllocatedBytes,
};
const report = {
  schemaVersion: 1,
  modes,
  ratios: {
    total: shared.medianWallMs / local.medianWallMs,
    preparation: shared.medianPreparationMs / local.medianPreparationMs,
    peak: shared.peakAllocatedBytes / local.peakAllocatedBytes,
  },
  gates,
  nativeQualified: Object.values(gates).every(Boolean),
  caveat:
    "Observed phase-boundary allocations exclude directory/MFT overhead; they are not continuous system-wide peak sampling.",
};
const destination = path.join(path.dirname(path.resolve(input)), "qualification.json");
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
