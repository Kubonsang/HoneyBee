import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  interruptionCases,
  runInterruptionMatrix,
  RestartPending,
} from "./interruption-matrix.mjs";

const fixture = async () => {
  const parent = path.resolve("output/matrix-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "case-"));
  const state = {
    boot: "2026-09-14T00:00:00Z",
    injected: [],
    recoveries: [],
    loseEdits: false,
    fail: null,
  };
  const before = { schemaVersion: 1, source: "preserved" };
  const operations = {
    bootId: async () => state.boot,
    sourceHealth: async () => {},
    snapshot: async () => ({ ...before, source: state.loseEdits ? "lost" : "preserved" }),
    inject: async ({ scenario }) => {
      state.injected.push(scenario.id);
      if (state.fail === scenario.id) throw Error("injection failed");
      return {
        reached: true,
        point: scenario.point,
        reachedAt: new Date(Date.parse(state.boot) + 1000).toISOString(),
        holdDeadline: new Date(Date.parse(state.boot) + 5 * 60 * 1000).toISOString(),
      };
    },
    recover: async ({ scenario }) => {
      state.recoveries.push(scenario.id);
      return { state: "RolledBack" };
    },
  };
  return {
    directory,
    kind: "service",
    candidate: { setupSha256: "fixed" },
    before,
    dataset: {},
    operations,
    state,
  };
};
test("focused reboot executes only the selected case and resumes without reinjection", async () => {
  const f = await fixture();
  const options = { ...f, onlyCase: "reboot-service-replaced" };
  await assert.rejects(runInterruptionMatrix(options), RestartPending);
  assert.deepEqual(f.state.injected, [options.onlyCase]);
  await assert.rejects(runInterruptionMatrix(options), RestartPending);
  f.state.boot = "2026-09-14T00:01:00Z";
  const result = await runInterruptionMatrix(options);
  assert.equal(result.completed, 1);
  assert.equal(result.acceptancePromoted, false);
  assert.deepEqual(f.state.injected, [options.onlyCase]);
  assert.deepEqual(f.state.recoveries, [options.onlyCase]);
  await assert.rejects(runInterruptionMatrix({ ...options, onlyCase: "unknown" }), /Unknown/);
  await assert.rejects(
    runInterruptionMatrix({ ...options, onlyCase: "reboot-app-selected" }),
    /wrong-kind/,
  );
  await assert.rejects(
    runInterruptionMatrix({ ...options, candidate: { setupSha256: "different" } }),
    /different candidate/,
  );
});
test("fixed matrix contains exactly 7 kills, 2 reboots, 1 poweroff and 2 rollback cases", () => {
  for (const [action, n] of [
    ["kill", 7],
    ["reboot", 2],
    ["poweroff", 1],
    ["fail", 2],
  ])
    assert.equal(interruptionCases.filter((c) => c.action === action).length, n);
  assert.equal(new Set(interruptionCases.map((c) => c.id)).size, 12);
});
test("service reboot and poweroff resume validation without replaying completed cases", async () => {
  const f = await fixture();
  await assert.rejects(runInterruptionMatrix(f), RestartPending);
  const injected = [...f.state.injected];
  await assert.rejects(runInterruptionMatrix(f), RestartPending);
  assert.deepEqual(f.state.injected, injected);
  f.state.boot = "2026-09-14T00:01:00Z";
  await assert.rejects(runInterruptionMatrix(f), RestartPending);
  assert.equal(f.state.injected.filter((id) => id === "reboot-service-replaced").length, 1);
  f.state.boot = "2026-09-14T00:02:00Z";
  const result = await runInterruptionMatrix(f);
  assert.equal(result.completed, 7);
  assert.equal(result.acceptancePromoted, false);
  await runInterruptionMatrix(f);
  assert.equal(f.state.injected.length, 7);
});
test("failed case retries only that case, preserves old evidence, and refuses other candidates", async () => {
  const f = await fixture();
  f.state.fail = "kill-service-stopped";
  await assert.rejects(runInterruptionMatrix(f), /injection failed/);
  await assert.rejects(runInterruptionMatrix(f), /Case failed/);
  const before = [...f.state.injected];
  f.state.fail = null;
  await assert.rejects(
    runInterruptionMatrix({ ...f, retryCase: "kill-service-stopped" }),
    RestartPending,
  );
  assert.equal(f.state.injected.filter((id) => id === "kill-service-backup-verified").length, 1);
  assert.equal(f.state.injected.filter((id) => id === "kill-service-stopped").length, 2);
  assert(before.length < f.state.injected.length);
  assert((await readdir(f.directory)).includes("kill-service-stopped-attempt-000"));
  assert(
    JSON.parse(
      await readFile(path.join(f.directory, "kill-service-stopped-attempt-000/failed.json")),
    ).error.includes("injection failed"),
  );
  await assert.rejects(
    runInterruptionMatrix({ ...f, candidate: { setupSha256: "other" } }),
    /different candidate/,
  );
});
test("lost source data prevents injection and cannot become a successful recovery", async () => {
  const f = await fixture();
  f.state.loseEdits = true;
  await assert.rejects(runInterruptionMatrix(f), /edited file changed/);
  assert.deepEqual(f.state.injected, []);
});

test("a restart after the checkpoint hold expired is not counted as interruption coverage", async () => {
  const f = await fixture();
  await assert.rejects(runInterruptionMatrix(f), RestartPending);
  const recoveries = [...f.state.recoveries];
  f.state.boot = "2026-09-14T01:00:00Z";
  await assert.rejects(runInterruptionMatrix(f), /missed the held checkpoint window/);
  assert.deepEqual(f.state.recoveries, recoveries);
});
