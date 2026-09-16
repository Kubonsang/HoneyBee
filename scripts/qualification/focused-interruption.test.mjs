import assert from "node:assert/strict";
import test from "node:test";
import {
  runFocusedInterruption,
  requiredQualificationArtifacts,
  focusedContinuationAdmission,
} from "./focused-interruption.mjs";
import { requireQualificationSpace } from "./integrated-flow.mjs";
import { RestartPending } from "./interruption-matrix.mjs";

test("reviewed baseline resume rechecks health and refuses any started case or repeated failed resume", async () => {
  const history = [{ phase: "preflight", state: "Completed" }];
  const record = async (e) => history.push(e);
  record.history = history;
  let health = 0,
    checked = 0;
  const options = {
    caseId: "poweroff-service-replaced",
    resumeBaseline: true,
    record,
    reviewed: { dataset: {}, before: {} },
    operations: {
      assertNoCaseStarted: async () => {
        checked++;
      },
      baseline: async () => {
        health++;
      },
      failureMatrix: async () => ({
        completed: 1,
        results: [{ identity: { scenario: { id: "poweroff-service-replaced" } } }],
      }),
    },
  };
  const result = await runFocusedInterruption(options);
  assert.equal(result.focusedCasePassed, true);
  assert.equal(health, 1);
  assert.equal(checked, 1);
  assert.equal(history[1].state, "ReviewedResumeStarted");
  const denied = async () => {};
  denied.history = [{ phase: "preflight", state: "Completed" }];
  await assert.rejects(
    runFocusedInterruption({
      ...options,
      record: denied,
      operations: {
        ...options.operations,
        assertNoCaseStarted: async () => {
          throw Error("existing attempt");
        },
      },
    }),
    /existing attempt/,
  );
  const failed = [];
  const failedRecord = async (e) => failed.push(e);
  failed.push({ phase: "preflight", state: "Completed" });
  failedRecord.history = failed;
  const failing = {
    ...options,
    record: failedRecord,
    operations: {
      ...options.operations,
      baseline: async () => {
        throw Error("unhealthy");
      },
    },
  };
  await assert.rejects(runFocusedInterruption(failing), /unhealthy/);
  await assert.rejects(runFocusedInterruption(failing), /only the original preflight/);
});

test("only focused service reboot can defer Setup and later app payloads; integrity metadata and service stay required", () => {
  const artifacts = [
    "HoneyBeeSetup.exe",
    "updates/app-1/application.zip",
    "updates/app-2/application.zip",
    "updates/service/application.zip",
    "updates/service/release.json",
    "updates/service/release.sig.json",
    "production/release.json",
    "updates/app-1/release.json",
    "other.zip",
  ].map((destination) => ({ destination, sha256: "unchanged" }));
  const before = globalThis.structuredClone(artifacts);
  const required = requiredQualificationArtifacts(artifacts, "reboot-service-replaced");
  assert.deepEqual(required, artifacts.slice(3));
  assert.deepEqual(
    requiredQualificationArtifacts(artifacts, "poweroff-service-replaced"),
    required,
  );
  for (const scope of [undefined, "reboot-app-selected", "kill-service-replaced"])
    assert.deepEqual(requiredQualificationArtifacts(artifacts, scope), artifacts);
  assert.deepEqual(artifacts, before);
});

test("poweroff continues only the same passed reboot candidate and original capacity admission", () => {
  const candidate = { setupSha256: "setup", manifestSha256: "manifest" },
    inputsSha256 = "inputs";
  const guest = {
    computerName: "vm",
    userSid: "sid",
    installationRoot: "root",
    freeBytes: 15 * 1024 ** 3,
  };
  const initial = {
    phase: "preflight",
    state: "Completed",
    result: {
      candidate,
      inputsSha256,
      focusedCase: "reboot-service-replaced",
      guest: { ...guest, freeBytes: 17 * 1024 ** 3 },
    },
  };
  const done = {
    phase: "focused-case",
    state: "Completed",
    result: {
      completed: 1,
      results: [
        {
          identity: {
            candidate: { ...candidate, inputsSha256 },
            scenario: { id: "reboot-service-replaced" },
          },
          preserved: true,
          recovery: { state: "RolledBack" },
        },
      ],
    },
  };
  const options = {
    caseId: "poweroff-service-replaced",
    history: [initial, done],
    candidate,
    inputsSha256,
    guest,
  };
  const admission = focusedContinuationAdmission(options);
  requireQualificationSpace(guest.freeBytes, admission);
  for (const change of [
    { candidate: {} },
    { inputsSha256: "changed" },
    { guest: { ...guest, userSid: "other" } },
    { history: [initial] },
    { caseId: "unknown" },
  ])
    assert.throws(() => focusedContinuationAdmission({ ...options, ...change }));
  const low = globalThis.structuredClone(options);
  low.history[0].result.guest.freeBytes = 15 * 1024 ** 3;
  assert.throws(
    () => requireQualificationSpace(guest.freeBytes, focusedContinuationAdmission(low)),
    /Original capacity admission missing/,
  );
});

test("focused restart preserves baseline, resumes only validation, and never claims full completion", async () => {
  const caseId = "reboot-service-replaced",
    history = [];
  const record = async (event) => history.push(event);
  record.history = history;
  let baselineCalls = 0,
    restart = true;
  const reviewed = { dataset: { projectId: "preserved" }, before: { dirty: "unchanged" } };
  const operations = {
    preflight: async () => ({ focusedCase: caseId }),
    baseline: async () => baselineCalls++,
    failureMatrix: async (kind, dataset, before) => {
      assert.equal(kind, "service");
      assert.deepEqual({ dataset, before }, reviewed);
      if (restart) throw new RestartPending({ checkpoint: "service-replaced" });
      return { completed: 1, results: [{ identity: { scenario: { id: caseId } } }] };
    },
  };
  const pending = await runFocusedInterruption({ caseId, operations, record, reviewed });
  assert.equal(pending.pendingRestart, true);
  assert.equal(pending.completed, false);
  restart = false;
  const result = await runFocusedInterruption({ caseId, operations, record });
  assert.equal(result.focusedCasePassed, true);
  assert.equal(result.completed, false);
  assert.equal(result.acceptancePromoted, false);
  assert.equal(baselineCalls, 1);
});

test("interrupted baseline preparation and a different result cannot count as focused success", async () => {
  const record = async () => {};
  record.history = [{ phase: "preflight", state: "Completed" }];
  await assert.rejects(
    runFocusedInterruption({ caseId: "reboot-service-replaced", operations: {}, record }),
    /baseline record missing/,
  );
  record.history.push({
    phase: "focused-baseline",
    state: "Completed",
    result: { dataset: {}, before: {} },
  });
  await assert.rejects(
    runFocusedInterruption({
      caseId: "reboot-service-replaced",
      record,
      operations: {
        failureMatrix: async () => ({
          completed: 1,
          results: [{ identity: { scenario: { id: "another" } } }],
        }),
      },
    }),
    /AssertionError/,
  );
});
