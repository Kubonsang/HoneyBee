import assert from "node:assert/strict";
import test from "node:test";
import { RestartPending } from "./interruption-matrix.mjs";
import { remainingServiceCases, runRemainingServiceFlow } from "./remaining-service-flow.mjs";

const fixture = () => {
  const calls = [];
  const record = async (entry) => record.history.push(entry);
  record.history = [];
  const inputs = {
    qualificationOnly: true,
    remainingServiceCases: [...remainingServiceCases],
    finalNativeHostSha256: "same-native-host",
    servicePair: {
      sourceKind: "instrumented-qa-baseline",
      source: { version: "0.1.0-beta.31" },
      target: { version: "0.1.0-beta.32", host: { sha256: "same-native-host" } },
    },
    updates: [{ name: "service" }],
  };
  const operations = {
    preflight: async () => calls.push("preflight"),
    baseline: async () => calls.push("baseline"),
    dataset: async () => ({ projectId: "fixture" }),
    health: async () => {},
    snapshot: async () => ({ schemaVersion: 1 }),
    failureMatrix: async (_kind, _dataset, _before, id) => {
      calls.push(id);
      return {
        completed: 1,
        results: [
          { identity: { scenario: { id } }, recovery: { state: "RolledBack" }, preserved: true },
        ],
      };
    },
    update: async () => {
      calls.push("handoff");
      return { state: "Committed", ready: true };
    },
  };
  return { inputs, operations, record, calls };
};

for (const mode of ["resume", "unreviewed", "changed-data", "native-admitted"]) {
  test(`cancelled production handoff: ${mode}`, async () => {
    const f = fixture();
    const update = f.operations.update;
    f.operations.update = async () => {
      throw Error("HoneyBee service update was cancelled");
    };
    await assert.rejects(runRemainingServiceFlow(f), /was cancelled/);
    const matrixCalls = f.calls.filter((x) => x.includes("service-"));
    assert.deepEqual(matrixCalls, remainingServiceCases);
    f.operations.update = update;
    f.retryCase = mode === "unreviewed" ? undefined : "production-handoff";
    f.operations.reviewCancelledHandoff = async () => {
      if (mode === "native-admitted") throw Error("Native admission exists");
      return { cancelledBeforeAdmission: true };
    };
    if (mode === "changed-data") f.operations.snapshot = async () => ({ changed: true });
    if (mode === "resume") {
      assert.equal((await runRemainingServiceFlow(f)).remainingServiceBatchPassed, true);
      assert.equal(f.calls.filter((x) => x === "handoff").length, 1);
    } else {
      await assert.rejects(runRemainingServiceFlow(f));
      assert(!f.calls.includes("handoff"));
    }
    assert.deepEqual(
      f.calls.filter((x) => x.includes("service-")),
      matrixCalls,
    );
    assert(
      f.record.history.some((e) => e.error === "Error: HoneyBee service update was cancelled"),
    );
  });
}
test("stops on a failure without replay or production handoff", async () => {
  const f = fixture();
  f.operations.failureMatrix = async () => {
    throw Error("real failure");
  };
  await assert.rejects(runRemainingServiceFlow(f), /real failure/);
  await assert.rejects(runRemainingServiceFlow(f), /retain failure/);
  assert(!f.calls.includes("handoff"));
  assert.equal(f.calls.filter((x) => x === "baseline").length, 1);
});
test("reboot resumes the pending matrix case without reinstalling baseline", async () => {
  const f = fixture();
  f.operations.failureMatrix = async (_kind, _dataset, _before, id) => {
    f.calls.push(id);
    if (id === "reboot-service-replaced") throw new RestartPending({ caseId: id });
    return {
      completed: 1,
      results: [
        { identity: { scenario: { id } }, recovery: { state: "RolledBack" }, preserved: true },
      ],
    };
  };
  assert((await runRemainingServiceFlow(f)).pendingRestart);
  f.operations.failureMatrix = async (_kind, _dataset, _before, id) => {
    f.calls.push(id);
    throw Error("stop after confirming resume position");
  };
  await assert.rejects(runRemainingServiceFlow(f), /confirming resume position/);
  assert.equal(f.calls.filter((x) => x === "baseline").length, 1);
  assert.equal(f.calls.filter((x) => x === "kill-service-replaced").length, 1);
  assert.equal(f.calls.at(-1), "reboot-service-replaced");
});
test("completes only the selected cases and resumes without repeated mutations", async () => {
  const f = fixture();
  const first = await runRemainingServiceFlow(f);
  assert.equal(first.remainingServiceBatchPassed, true);
  assert.equal(first.waitingForPublicDelivery, true);
  assert.equal(first.publicationAllowed, false);
  const calls = [...f.calls];
  await runRemainingServiceFlow(f);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(
    f.calls.filter((id) => id.includes("service-")),
    remainingServiceCases,
  );
});
test("incomplete matrix output cannot authorize production handoff", async () => {
  const f = fixture();
  f.operations.failureMatrix = async () => ({ completed: 0, results: [] });
  await assert.rejects(runRemainingServiceFlow(f));
  assert(!f.calls.includes("handoff"));
});
test("rejects a changed native target or added interruption point before actions", async () => {
  for (const change of ["native", "scope"]) {
    const f = fixture();
    if (change === "native") f.inputs.finalNativeHostSha256 = "changed";
    else f.inputs.remainingServiceCases.push("poweroff-service-replaced");
    await assert.rejects(runRemainingServiceFlow(f));
    assert.equal(f.calls.length, 0);
  }
});

test("reviewed pre-controller UAC cancellation resumes case four and retains the first three", async () => {
  const f = fixture();
  const original = f.operations.failureMatrix;
  f.operations.failureMatrix = async (...args) => {
    if (args[3] === "kill-service-validated")
      throw Error("launch-native-fault.ps1: The operation was canceled by the user");
    return original(...args);
  };
  await assert.rejects(runRemainingServiceFlow(f), /canceled/);
  f.operations.reviewCancelledController = async (id) => assert.equal(id, "kill-service-validated");
  f.operations.failureMatrix = original;
  assert.equal(
    (await runRemainingServiceFlow({ ...f, retryCase: "kill-service-validated" }))
      .remainingServiceBatchPassed,
    true,
  );
  for (const id of remainingServiceCases.slice(0, 3))
    assert.equal(f.calls.filter((c) => c === id).length, 1);
  assert(f.record.history.some((e) => e.state === "Failed"));
});

test("controller evidence uncertainty prevents the reviewed retry", async () => {
  const f = fixture();
  f.record.history.push(
    { phase: "kill-service-validated-matrix", state: "Started" },
    {
      phase: "kill-service-validated-matrix",
      state: "Failed",
      error: "launch-native-fault.ps1: The operation was canceled by the user",
    },
  );
  f.operations.reviewCancelledController = async () => {
    throw Error("controller evidence exists");
  };
  await assert.rejects(
    runRemainingServiceFlow({ ...f, retryCase: "kill-service-validated" }),
    /controller evidence exists/,
  );
  assert(!f.calls.includes("kill-service-validated"));
});

test("reviewed Doctor failure before controller start can resume without replaying completed cases", async () => {
  const f = fixture();
  f.record.history.push(
    { phase: "kill-service-validated-matrix", state: "Started" },
    {
      phase: "kill-service-validated-matrix",
      state: "Failed",
      error: "launch-native-fault.ps1: The operation was canceled by the user",
    },
    { phase: "kill-service-validated-matrix", state: "Started" },
    {
      phase: "kill-service-validated-matrix",
      state: "Failed",
      error: "Command failed: honeybee.exe doctor --json",
    },
  );
  f.operations.reviewCancelledController = async () => {};
  assert.equal(
    (await runRemainingServiceFlow({ ...f, retryCase: "kill-service-validated" }))
      .remainingServiceBatchPassed,
    true,
  );
  assert.equal(f.record.history.filter((e) => e.state === "Failed").length, 2);
});

test("recorded rollback review permits one affected-case retry after the overly strict evidence guard", async () => {
  const f = fixture();
  f.record.history.push(
    { phase: "kill-service-validated-matrix", state: "Started" },
    {
      phase: "kill-service-validated-matrix",
      state: "Failed",
      error: "launch-native-fault.ps1: The operation was canceled by the user",
    },
    { phase: "kill-service-validated-matrix", state: "Started" },
    {
      phase: "kill-service-validated-matrix",
      state: "Failed",
      error: "Command failed: honeybee.exe doctor --json",
    },
    {
      phase: "kill-service-validated-matrix",
      state: "Failed",
      error: "Expected values to be strictly deep-equal",
    },
  );
  let reviews = 0;
  f.operations.reviewCancelledController = async () => {
    reviews++;
  };
  assert.equal(
    (await runRemainingServiceFlow({ ...f, retryCase: "kill-service-validated" }))
      .remainingServiceBatchPassed,
    true,
  );
  assert.equal(reviews, 1);
  assert.equal(f.record.history.filter((e) => e.state === "Failed").length, 3);
});
