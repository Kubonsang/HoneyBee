import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, open, readdir } from "node:fs/promises";
import { readBounded } from "../update/prepare-release.mjs";
import { assertPreserved } from "./preservation.mjs";

export const interruptionCases = Object.freeze([
  ...[
    "app-prepared",
    "app-selected",
    "app-validated",
    "service-backup-verified",
    "service-stopped",
    "service-replaced",
    "service-validated",
  ].map((point) => ({ id: `kill-${point}`, point, action: "kill" })),
  ...["app-selected", "service-replaced"].map((point) => ({
    id: `reboot-${point}`,
    point,
    action: "reboot",
  })),
  { id: "poweroff-service-replaced", point: "service-replaced", action: "poweroff" },
  { id: "rollback-app-health", point: "app-health-failure", action: "fail" },
  { id: "rollback-service-health", point: "service-health-failure", action: "fail" },
]);
export class RestartPending extends Error {
  constructor(detail) {
    super("QA guest restart/power-off required at the recorded checkpoint");
    this.name = "RestartPending";
    this.detail = detail;
  }
}
const optional = async (file) => {
  try {
    return JSON.parse(await readBounded(file, 8 * 1024 * 1024));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
export async function durableQARecord(file, value) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Fixed ten interruption points plus the existing two rollback gates. Completed
 * cases are retained. A reboot resumes validation, never the interrupted update. */
export async function runInterruptionMatrix({
  directory,
  kind,
  candidate,
  before,
  dataset,
  operations,
  retryCase,
  onlyCase,
}) {
  assert(["app", "service"].includes(kind));
  assert(
    onlyCase === undefined ||
      interruptionCases.some((c) => c.id === onlyCase && c.point.startsWith(kind + "-")),
    "Unknown or wrong-kind focused case",
  );
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const scenario of interruptionCases.filter(
    (c) => c.point.startsWith(kind + "-") && (onlyCase === undefined || c.id === onlyCase),
  )) {
    const attempts = (await readdir(directory))
      .filter((name) => name.startsWith(scenario.id + "-attempt-"))
      .sort();
    for (const [index, name] of attempts.entries())
      assert.equal(name, scenario.id + "-attempt-" + String(index).padStart(3, "0"));
    assert(attempts.length < 100, "QA retry bound exceeded");
    let selected = attempts.at(-1) ?? scenario.id + "-attempt-000";
    if (
      retryCase === scenario.id &&
      (await optional(path.join(directory, selected, "failed.json")))
    ) {
      await operations.sourceHealth(kind);
      assertPreserved(before, await operations.snapshot(dataset));
      selected = scenario.id + "-attempt-" + String(attempts.length).padStart(3, "0");
    }
    const caseRoot = path.join(directory, selected);
    await mkdir(caseRoot, { recursive: true });
    const identity = { schemaVersion: 1, candidate, scenario };
    const existing = await optional(path.join(caseRoot, "identity.json"));
    if (existing) assert.deepEqual(existing, identity, "Case belongs to different candidate");
    else await durableQARecord(path.join(caseRoot, "identity.json"), identity);
    const completed = await optional(path.join(caseRoot, "completed.json"));
    if (completed) {
      assert.deepEqual(completed.identity, identity);
      assert.equal(completed.preserved, true);
      results.push(completed);
      continue;
    }
    const failed = await optional(path.join(caseRoot, "failed.json"));
    assert(!failed, "Case failed; review evidence before an explicit affected-case retry");
    try {
      const pending = await optional(path.join(caseRoot, "interrupted.json"));
      if (pending) {
        assert.deepEqual(pending.identity, identity);
        if (scenario.action === "reboot") {
          const currentBoot = await operations.bootId();
          if (currentBoot !== pending.bootId) {
            assert(
              Number.isFinite(Date.parse(pending.proof.holdDeadline)) &&
                Number.isFinite(Date.parse(pending.proof.reachedAt)),
              "Checkpoint hold evidence missing",
            );
            assert(
              Date.parse(currentBoot) >= Date.parse(pending.proof.reachedAt) &&
                Date.parse(currentBoot) <= Date.parse(pending.proof.holdDeadline),
              "Restart missed the held checkpoint window; case must not pass",
            );
          }
        }
        if (
          ["reboot", "poweroff"].includes(scenario.action) &&
          pending.bootId === (await operations.bootId())
        )
          throw new RestartPending({ caseRoot, ...pending });
      } else {
        assert.equal(
          await optional(path.join(caseRoot, "started.json")),
          null,
          "Interrupted controller has no proven checkpoint; do not replay mutations",
        );
        await operations.sourceHealth(kind);
        assertPreserved(before, await operations.snapshot(dataset));
        const bootId = await operations.bootId();
        await durableQARecord(path.join(caseRoot, "started.json"), { identity, bootId });
        const priorRoot =
          attempts.length > 0 && selected !== attempts.at(-1)
            ? path.join(directory, attempts.at(-1))
            : undefined;
        const proof = await operations.inject({ scenario, caseRoot, priorRoot });
        assert.equal(proof.reached, true, "Required checkpoint was not reached");
        assert.equal(proof.point, scenario.point);
        const interrupted = { identity, bootId, proof };
        await durableQARecord(path.join(caseRoot, "interrupted.json"), interrupted);
        if (["reboot", "poweroff"].includes(scenario.action))
          throw new RestartPending({ caseRoot, ...interrupted });
      }
      const recovery = await operations.recover({ scenario, caseRoot });
      assert.equal(recovery.state, "RolledBack", "Old known-good pair was not restored");
      await operations.sourceHealth(kind);
      assertPreserved(before, await operations.snapshot(dataset));
      const result = { identity, recovery, preserved: true, acceptancePromoted: false };
      await durableQARecord(path.join(caseRoot, "completed.json"), result);
      results.push(result);
    } catch (error) {
      if (error instanceof RestartPending) throw error;
      await durableQARecord(path.join(caseRoot, "failed.json"), {
        identity,
        error: String(error),
        replayAllowed: false,
      });
      throw error;
    }
  }
  return { schemaVersion: 1, kind, completed: results.length, results, acceptancePromoted: false };
}
