import assert from "node:assert/strict";
import { assertPreserved } from "./preservation.mjs";
import { RestartPending } from "./interruption-matrix.mjs";

export const remainingServiceCases = Object.freeze([
  "kill-service-backup-verified",
  "kill-service-stopped",
  "kill-service-replaced",
  "kill-service-validated",
  "reboot-service-replaced",
  "rollback-service-health",
]);

// Candidate-specific remaining work. Prior successful app cases, power-off,
// Repair and consecutive-update qualifications are not replayed here.
export async function runRemainingServiceFlow({ inputs, operations, record, retryCase }) {
  assert.equal(inputs.qualificationOnly, true);
  assert.deepEqual(inputs.remainingServiceCases, remainingServiceCases);
  assert.equal(inputs.servicePair.sourceKind, "instrumented-qa-baseline");
  assert.equal(inputs.servicePair.source.version, "0.1.0-beta.31");
  assert.equal(inputs.servicePair.target.version, "0.1.0-beta.32");
  assert.equal(inputs.servicePair.target.host.sha256, inputs.finalNativeHostSha256);
  let phase;
  const step = async (name, action, matrix = false) => {
    phase = name;
    const previous = record.history.filter((event) => event.phase === name);
    const completed = previous.findLast((event) => event.state === "Completed");
    if (completed) return completed.result;
    const reviewedRetry =
      retryCase === "kill-service-validated" &&
      name === `${retryCase}-matrix` &&
      (previous.length === 2 ||
        ((previous.length === 4 ||
          (previous.length === 5 &&
            previous[4].state === "Failed" &&
            /Expected values to be strictly deep-equal/.test(previous[4].error ?? ""))) &&
          previous[2].state === "Started" &&
          previous[3].state === "Failed" &&
          /honeybee\.exe doctor --json/.test(previous[3].error ?? ""))) &&
      previous[0].state === "Started" &&
      previous[1].state === "Failed" &&
      /launch-native-fault\.ps1/.test(previous[1].error ?? "") &&
      /The operation was canceled by the user/.test(previous[1].error ?? "");
    if (reviewedRetry) await operations.reviewCancelledController(retryCase);
    const reviewedHandoff =
      retryCase === "production-handoff" &&
      name === "production-handoff" &&
      previous.length === 2 &&
      previous[0].state === "Started" &&
      previous[1].state === "Failed" &&
      previous[1].error === "Error: HoneyBee service update was cancelled";
    const handoffReview = reviewedHandoff ? await operations.reviewCancelledHandoff() : undefined;
    assert(
      reviewedRetry || reviewedHandoff || !previous.some((event) => event.state === "Failed"),
      `${name}: retain failure; no replay`,
    );
    assert(
      reviewedRetry ||
        reviewedHandoff ||
        !previous.length ||
        (matrix && previous.at(-1).state === "WaitingForRestart"),
      `${name}: incomplete external action requires review`,
    );
    await record({ phase: name, state: "Started", ...(reviewedHandoff ? { handoffReview } : {}) });
    const result = await action();
    await record({ phase: name, state: "Completed", result });
    return result;
  };
  try {
    await step("preflight", operations.preflight);
    await step("baseline-setup", operations.baseline);
    const dataset = await step("dataset", operations.dataset);
    const before = await step("baseline-health", async () => {
      await operations.health(inputs.servicePair.source.version, inputs.servicePair.source);
      return operations.snapshot(dataset);
    });
    for (const caseId of remainingServiceCases)
      await step(
        `${caseId}-matrix`,
        async () => {
          const result = await operations.failureMatrix("service", dataset, before, caseId);
          assert.equal(result.completed, 1);
          assert.equal(result.results.length, 1);
          assert.equal(result.results[0].identity.scenario.id, caseId);
          assert.equal(result.results[0].recovery.state, "RolledBack");
          assert.equal(result.results[0].preserved, true);
          return result;
        },
        true,
      );
    // Leave a production service and beta.32 app for the real public beta.35
    // download. This transition is fixture handoff, not a replayed gate-06 pass.
    await step("production-handoff", async () => {
      await operations.health(inputs.servicePair.source.version, inputs.servicePair.source);
      assertPreserved(before, await operations.snapshot(dataset));
      const result = await operations.update(inputs.updates[0]);
      assert.equal(result.state, "Committed");
      assert.equal(result.ready, true);
      await operations.health(inputs.servicePair.target.version, inputs.servicePair.target);
      assertPreserved(before, await operations.snapshot(dataset));
      return result;
    });
    const result = {
      schemaVersion: 1,
      remainingServiceBatchPassed: true,
      cases: remainingServiceCases,
      candidate: inputs.candidate,
      exercisedSourceVersion: inputs.servicePair.source.version,
      exercisedTargetVersion: inputs.servicePair.target.version,
      finalNativeHostSha256: inputs.finalNativeHostSha256,
      preserved: true,
      projectId: dataset.projectId,
      waitingForPublicDelivery: true,
      acceptancePromoted: false,
      publicationAllowed: false,
    };
    await step("remaining-services", async () => result);
    return result;
  } catch (error) {
    if (error instanceof RestartPending) {
      await record({ phase, state: "WaitingForRestart", detail: error.detail });
      return { pendingRestart: error.detail, publicationAllowed: false };
    }
    await record({ phase, state: "Failed", error: String(error), replayAllowed: false });
    throw error;
  }
}
