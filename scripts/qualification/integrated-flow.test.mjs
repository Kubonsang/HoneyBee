import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createEvidenceWriter, runIntegratedFlow } from "./integrated-flow.mjs";
import { RestartPending } from "./interruption-matrix.mjs";

const inputs = {
  qualificationOnly: true,
  candidate: { setupSha256: "candidate" },
  servicePair: {
    historicalMigrationQualified: false,
    sourceKind: "instrumented-qa-baseline",
    source: { version: "11" },
    target: {},
  },
  updates: [
    { name: "service", from: "11", to: "12" },
    { name: "app-1", from: "12", to: "13" },
    { name: "app-2", from: "13", to: "14" },
  ],
};
const fixture = () => {
  const calls = [],
    events = [];
  const operations = Object.fromEntries(
    ["preflight", "baseline", "dataset", "health", "repair"].map((name) => [
      name,
      async () => {
        calls.push(name);
        return {};
      },
    ]),
  );
  operations.snapshot = async () => ({ schemaVersion: 1, edited: "preserved" });
  operations.update = async ({ name }) => {
    calls.push(name);
    return { state: "Committed", ready: true };
  };
  return {
    operations,
    calls,
    events,
    record: async (e) => {
      events.push(e);
    },
  };
};

test("reviewed dataset recovery preserves failure evidence and never repeats Setup", async () => {
  const f = fixture();
  f.record.history = f.events;
  f.operations.dataset = async () => {
    throw Error(
      "cache prepare storage.operation-failed The system cannot find the file specified.",
    );
  };
  await assert.rejects(runIntegratedFlow({ inputs, ...f }));
  const original = JSON.parse(JSON.stringify(f.events));
  let resumed = 0;
  f.operations.resumeDataset = async () => {
    resumed++;
    return { projectId: "retained" };
  };
  assert.equal((await runIntegratedFlow({ inputs, ...f })).completed, true);
  assert.equal(resumed, 1);
  assert.equal(f.calls.filter((c) => c === "baseline").length, 1);
  assert.deepEqual(f.events.slice(0, original.length), original);
  assert(f.events.some((e) => e.state === "ReviewedResumeStarted"));
});

test("failed reviewed recovery cannot replay even with the explicit option", async () => {
  const f = fixture();
  f.record.history = f.events;
  f.operations.dataset = async () => {
    throw Error(
      "cache prepare storage.operation-failed The system cannot find the file specified.",
    );
  };
  await assert.rejects(runIntegratedFlow({ inputs, ...f }));
  let calls = 0;
  f.operations.resumeDataset = async () => {
    calls++;
    throw Error("guard or operation failed");
  };
  await assert.rejects(runIntegratedFlow({ inputs, ...f }), /guard or operation failed/);
  await assert.rejects(runIntegratedFlow({ inputs, ...f }), /only once/);
  assert.equal(calls, 1);
});

test("normal restart still refuses an interrupted dataset without reviewed recovery", async () => {
  const f = fixture();
  f.record.history = f.events;
  f.operations.dataset = async () => {
    throw Error("failed");
  };
  await assert.rejects(runIntegratedFlow({ inputs, ...f }));
  await assert.rejects(runIntegratedFlow({ inputs, ...f }), /not automatic replay/);
});
test("complete flow keeps Repair before consecutive updates and grants no release pass", async () => {
  const f = fixture();
  const result = await runIntegratedFlow({ inputs, ...f });
  assert.equal(result.completed, true);
  assert.equal(result.publicationAllowed, false);
  assert.equal(result.historicalMigrationQualified, false);
  assert(f.calls.indexOf("repair") > f.calls.indexOf("service"));
  assert(f.calls.indexOf("repair") < f.calls.indexOf("app-1"));
  assert.equal(f.events.at(-1).state, "Completed");
});
test("preflight refusal executes no installation or service actions", async () => {
  const f = fixture();
  f.operations.preflight = async () => {
    throw Error("Foreign installation");
  };
  await assert.rejects(runIntegratedFlow({ inputs, ...f }), /Foreign installation/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.at(-1).replayAllowed, false);
});
test("lost edits and a noncommitted update stop the chain without Repair or retries", async () => {
  for (const failure of ["edits", "rollback"]) {
    const f = fixture();
    let snapshots = 0;
    f.operations.snapshot = async () => ({
      schemaVersion: 1,
      edited: failure === "edits" ? snapshots++ : 0,
    });
    if (failure === "rollback")
      f.operations.update = async () => ({ state: "RolledBack", ready: false });
    await assert.rejects(runIntegratedFlow({ inputs, ...f }));
    assert(!f.calls.includes("repair"));
    assert(!f.calls.includes("app-1"));
    assert.equal(f.events.at(-1).phase, "service");
  }
});
test("evidence cannot overwrite an earlier attempt or continue when intent persistence fails", async () => {
  const parent = path.resolve("output/integrated-flow-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const directory = path.join(root, "Evidence");
  const record = await createEvidenceWriter(directory);
  await record({ phase: "service", state: "Started" });
  await assert.rejects(createEvidenceWriter(directory), { code: "EEXIST" });
  assert.equal(JSON.parse(await readFile(path.join(directory, "000.json"))).state, "Started");
  const f = fixture();
  await assert.rejects(
    runIntegratedFlow({
      inputs,
      ...f,
      record: async () => {
        throw Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.deepEqual(f.calls, []);
});

test("restart resume skips installation, dataset and completed actions", async () => {
  const f = fixture();
  f.record.history = f.events;
  let pending = true;
  f.operations.failureMatrix = async (kind) => {
    if (kind === "service" && pending) throw new RestartPending({ case: "fixed" });
    return { completed: true };
  };
  const first = await runIntegratedFlow({ inputs, ...f });
  assert(first.pendingRestart);
  pending = false;
  const second = await runIntegratedFlow({ inputs, ...f });
  assert(second.completed);
  assert.equal(f.calls.filter((c) => c === "baseline").length, 1);
  assert.equal(f.calls.filter((c) => c === "dataset").length, 1);
  assert.equal(f.calls.filter((c) => c === "service").length, 1);
});
