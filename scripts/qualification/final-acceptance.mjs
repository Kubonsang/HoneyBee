import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readBounded } from "../update/prepare-release.mjs";

export const fixedAcceptanceGates = Object.freeze([
  "fresh-setup",
  "git-uac",
  "zip-adoption",
  "discovery-download",
  "consecutive-updates",
  "service-migration",
  "workspace-preservation",
  "app-rollback",
  "service-rollback",
  "drain-duplicates",
  "compatibility-floors",
  "artifact-integrity",
  "capacity-locks",
  "repair",
  "interruption-matrix",
  "signed-setup-winget",
]);

/** New candidates start pending. Retained historical evidence may be attached
 * separately; generating a worksheet cannot grant any final pass. */
export function createFinalAcceptance(candidate) {
  const input = {
    schemaVersion: 1,
    candidate: { setupSha256: candidate.setupSha256, manifestSha256: candidate.manifestSha256 },
    gates: fixedAcceptanceGates.map((id) => ({ id, status: "pending", evidence: [] })),
  };
  summarizeFinalAcceptance(input);
  return input;
}

/** Records the already approved 16 gates. No tests are launched and no earlier
 * partial fixture is silently promoted into a final candidate pass. */
export function summarizeFinalAcceptance(input) {
  assert.equal(input.schemaVersion, 1);
  for (const field of ["setupSha256", "manifestSha256"])
    assert(/^[a-f0-9]{64}$/u.test(input.candidate?.[field]), "Final candidate hashes required");
  assert(
    Array.isArray(input.gates) && input.gates.length === 16,
    "Exactly the fixed 16 gates are required",
  );
  const byId = new Map(input.gates.map((gate) => [gate.id, gate]));
  assert.equal(byId.size, 16, "Duplicate gate");
  const gates = fixedAcceptanceGates.map((id, index) => {
    const gate = byId.get(id);
    assert(gate, `Missing fixed gate: ${id}`);
    assert(["pending", "partial", "passed", "failed", "blocked"].includes(gate.status));
    assert(
      Array.isArray(gate.evidence) &&
        gate.evidence.every((e) => typeof e === "string" && e.trim().length > 0),
    );
    if (["passed", "partial", "failed"].includes(gate.status))
      assert(gate.evidence.length > 0, "Evidence reference required");
    if (gate.status === "passed") {
      assert.deepEqual(gate.candidate, input.candidate, "Passed gate belongs to another candidate");
      assert.equal(
        gate.scope,
        "final",
        "Earlier fixture evidence is partial until final integration is covered",
      );
    }
    return { ...gate, number: index + 1 };
  });
  const counts = Object.fromEntries(
    ["pending", "partial", "passed", "failed", "blocked"].map((status) => [
      status,
      gates.filter((g) => g.status === status).length,
    ]),
  );
  return {
    schemaVersion: 1,
    candidate: input.candidate,
    counts,
    ready: counts.passed === 16,
    gates,
    evidenceVerifiedByTool: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = summarizeFinalAcceptance(
    JSON.parse(await readBounded(process.argv[2], 1024 * 1024)),
  );
  assert(process.argv[3], "Output report path required");
  await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ ready: report.ready, counts: report.counts }) + "\n");
}
