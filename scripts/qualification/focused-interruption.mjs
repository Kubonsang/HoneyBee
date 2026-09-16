import assert from "node:assert/strict";
import { interruptionCases, RestartPending } from "./interruption-matrix.mjs";

// The focused service reboot uses an existing reviewed installation and the
// service package only. Setup and later app payloads may remain on the host.
// Full qualification still requires every artifact in the immutable inputs.
export function requiredQualificationArtifacts(artifacts, onlyCase) {
  if (!["reboot-service-replaced", "poweroff-service-replaced"].includes(onlyCase))
    return artifacts;
  const deferred = new Set([
    "HoneyBeeSetup.exe",
    "updates/app-1/application.zip",
    "updates/app-2/application.zip",
  ]);
  return artifacts.filter((artifact) => !deferred.has(artifact.destination));
}

export function focusedContinuationAdmission({ caseId, history, candidate, inputsSha256, guest }) {
  assert.equal(caseId, "poweroff-service-replaced");
  const initial = history.find((e) => e.phase === "preflight" && e.state === "Completed");
  assert(initial, "Previous focused capacity admission missing");
  assert.equal(initial.result.focusedCase, "reboot-service-replaced");
  assert.deepEqual(initial.result.candidate, candidate);
  assert.equal(initial.result.inputsSha256, inputsSha256);
  for (const key of ["computerName", "userSid", "installationRoot"])
    assert.equal(initial.result.guest[key], guest[key], "Previous focused guest differs");
  const completed = history.find((e) => e.phase === "focused-case" && e.state === "Completed");
  assert.equal(completed?.result.completed, 1, "Previous reboot case has not passed");
  const result = completed.result.results[0];
  assert.deepEqual(result.identity.candidate, { ...candidate, inputsSha256 });
  assert.equal(result.identity.scenario.id, "reboot-service-replaced");
  assert.equal(result.recovery.state, "RolledBack");
  assert.equal(result.preserved, true);
  return initial;
}

// A single existing case may be checked first without claiming the whole matrix.
// Its ordinary bound Matrix record remains reusable by the full run later.
export async function runFocusedInterruption({
  caseId,
  operations,
  record,
  reviewed,
  resumeBaseline = false,
}) {
  const scenario = interruptionCases.find((item) => item.id === caseId);
  assert(scenario, "Unknown focused case");
  const history = record.history ?? [];
  let baseline = history.find(
    (e) => e.phase === "focused-baseline" && e.state === "Completed",
  )?.result;
  if (resumeBaseline && !baseline) {
    assert.equal(caseId, "poweroff-service-replaced");
    assert.equal(
      history.length,
      1,
      "Reviewed baseline resume requires only the original preflight record",
    );
    assert.equal(history[0].phase, "preflight");
    assert.equal(history[0].state, "Completed");
    assert(reviewed, "Fresh preservation review required before baseline resume");
    await operations.assertNoCaseStarted(caseId);
    await record({
      phase: "focused-baseline",
      state: "ReviewedResumeStarted",
      ...(reviewed.reviewedRepair ? { reviewedRepair: reviewed.reviewedRepair } : {}),
    });
    await operations.baseline();
    baseline = { dataset: reviewed.dataset, before: reviewed.before };
    await record({ phase: "focused-baseline", state: "Completed", result: baseline });
  }
  if (!history.some((e) => e.phase === "preflight" && e.state === "Completed")) {
    assert(reviewed, "Focused qualification requires a reviewed populated baseline");
    await record({ phase: "preflight", state: "Completed", result: await operations.preflight() });
    await operations.baseline();
    baseline = { dataset: reviewed.dataset, before: reviewed.before };
    await record({ phase: "focused-baseline", state: "Completed", result: baseline });
  }
  assert(baseline, "Focused baseline record missing; do not replay preparation");
  try {
    const result = await operations.failureMatrix(
      scenario.point.startsWith("service-") ? "service" : "app",
      baseline.dataset,
      baseline.before,
    );
    assert.equal(result.completed, 1);
    assert.equal(result.results[0].identity.scenario.id, caseId);
    await record({ phase: "focused-case", state: "Completed", result });
    return {
      completed: false,
      focusedCase: caseId,
      focusedCasePassed: true,
      acceptancePromoted: false,
    };
  } catch (error) {
    if (!(error instanceof RestartPending)) throw error;
    await record({ phase: "focused-case", state: "WaitingForRestart", detail: error.detail });
    return {
      completed: false,
      focusedCase: caseId,
      pendingRestart: true,
      acceptancePromoted: false,
    };
  }
}
