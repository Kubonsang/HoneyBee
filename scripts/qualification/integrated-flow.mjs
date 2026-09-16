import assert from "node:assert/strict";
import path from "node:path";
import { open, mkdir, readdir, readFile } from "node:fs/promises";
import { assertPreserved } from "./preservation.mjs";
import { RestartPending } from "./interruption-matrix.mjs";

// 16 GiB is the initial whole-run allowance, not an amount to replenish after
// each preparation or retained backup. Resume callers first validate the saved
// candidate, inputs, machine, user and installation identity. Product download,
// cold-backup and service-replacement capacity admission remains independent.
export function requireQualificationSpace(freeBytes, admittedPreflight) {
  assert(Number.isSafeInteger(freeBytes) && freeBytes >= 0, "Invalid free-space observation");
  const initialBytes = 16 * 1024 ** 3;
  const evidenceHeadroom = 64 * 1024 ** 2;
  if (admittedPreflight) {
    assert.equal(admittedPreflight.phase, "preflight");
    assert.equal(admittedPreflight.state, "Completed");
    assert(
      Number.isSafeInteger(admittedPreflight.result?.guest?.freeBytes) &&
        admittedPreflight.result.guest.freeBytes >= initialBytes,
      "Original capacity admission missing",
    );
  }
  const required = admittedPreflight ? evidenceHeadroom : initialBytes;
  assert(
    freeBytes >= required,
    `QA ${admittedPreflight ? "resume evidence" : "initial"} capacity: ${freeBytes} bytes available; ${required} required`,
  );
}

// Append-only evidence is flushed before each external action. A crashed QA
// driver must not replay service changes; product recovery owns that decision.
export async function createEvidenceWriter(directory, { resume = false } = {}) {
  const history = [];
  if (!resume) await mkdir(directory);
  else {
    const names = (await readdir(directory)).sort();
    assert(names.length <= 1000, "Evidence history exceeded");
    for (const [index, name] of names.entries()) {
      assert.equal(name, `${String(index).padStart(3, "0")}.json`, "Incomplete evidence history");
      const value = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      assert.equal(value.schemaVersion, 1);
      history.push(value);
    }
  }
  let sequence = history.length;
  const record = async (event) => {
    const file = await open(
      path.join(directory, `${String(sequence++).padStart(3, "0")}.json`),
      "wx",
    );
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: 1, ...event }, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    history.push({ schemaVersion: 1, ...event });
  };
  record.history = history;
  return record;
}

/** One real service transition, matching Setup Repair, then two app updates.
 * This produces observations, not acceptance-gate passes. Fault injection and
 * historical compatibility are separate scopes in the existing fixed matrix. */
export async function runIntegratedFlow({ inputs, operations, record }) {
  assert.equal(inputs.qualificationOnly, true);
  assert.equal(inputs.servicePair.historicalMigrationQualified, false);
  assert.equal(inputs.servicePair.sourceKind, "instrumented-qa-baseline");
  assert.deepEqual(
    inputs.updates.map((s) => s.name),
    ["service", "app-1", "app-2"],
  );
  assert.equal(inputs.updates[0].from, inputs.servicePair.source.version);
  for (let i = 1; i < inputs.updates.length; i++)
    assert.equal(inputs.updates[i].from, inputs.updates[i - 1].to);
  let active = "preflight";
  const step = async (name, action) => {
    active = name;
    const previous = (record.history ?? []).filter((e) => e.phase === name);
    const completed = previous.findLast((e) => e.state === "Completed");
    if (completed) return completed.result;
    const reviewedDataset = name === "dataset" && previous.length && operations.resumeDataset;
    if (reviewedDataset) {
      assert.deepEqual(
        previous.map((e) => e.state),
        ["Started", "Failed"],
        "Reviewed dataset recovery is allowed only once",
      );
      assert.match(previous[1].error, /cache prepare/);
      assert.match(previous[1].error, /storage\.operation-failed/);
      assert.match(previous[1].error, /The system cannot find the file specified/);
    } else {
      assert(
        !previous.length || name.endsWith("-matrix"),
        "Interrupted non-matrix action requires evidence review, not automatic replay",
      );
    }
    await record({ phase: name, state: reviewedDataset ? "ReviewedResumeStarted" : "Started" });
    const result = await (reviewedDataset ? operations.resumeDataset() : action());
    await record({ phase: name, state: "Completed", result });
    return result;
  };
  try {
    await step("preflight", operations.preflight);
    await step("baseline-setup", operations.baseline);
    const dataset = await step("dataset", operations.dataset);
    const before = await step("baseline-health", async () => {
      await operations.health(inputs.updates[0].from, inputs.servicePair.source);
      return operations.snapshot(dataset);
    });
    if (operations.failureMatrix)
      await step("service-matrix", () => operations.failureMatrix("service", dataset, before));
    for (const update of inputs.updates) {
      await step(update.name, async () => {
        const result = await operations.update(update);
        assert.equal(
          result.state,
          "Committed",
          "Update did not commit; retain product recovery evidence",
        );
        assert.equal(result.ready, true);
        const health = await operations.health(update.to, inputs.servicePair.target);
        const after = await operations.snapshot(dataset);
        assertPreserved(before, after);
        return { update: result, health, preservation: after };
      });
      if (update.name === "service") {
        await step("matching-setup-repair", async () => {
          const result = await operations.repair();
          const health = await operations.health(update.to, inputs.servicePair.target);
          assertPreserved(before, await operations.snapshot(dataset));
          return { result, health, preserved: true };
        });
        if (operations.failureMatrix)
          await step("app-matrix", () => operations.failureMatrix("app", dataset, before));
      }
    }
    const result = {
      schemaVersion: 1,
      completed: true,
      candidate: inputs.candidate,
      scope: "service-replacement-mechanics-and-consecutive-app-updates",
      historicalMigrationQualified: false,
      acceptancePromoted: false,
      publicationAllowed: false,
      finalVersion: inputs.updates.at(-1).to,
    };
    await record({ phase: "flow", state: "Completed", result });
    return result;
  } catch (error) {
    if (error instanceof RestartPending) {
      await record({ phase: active, state: "WaitingForRestart", detail: error.detail });
      return {
        schemaVersion: 1,
        completed: false,
        pendingRestart: error.detail,
        publicationAllowed: false,
      };
    }
    await record({ phase: active, state: "Failed", error: String(error), replayAllowed: false });
    throw error;
  }
}
