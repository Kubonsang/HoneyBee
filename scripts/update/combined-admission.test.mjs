import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertCombinedAdmission } from "../../packages/core/dist/combined-admission.js";
import { sha256 } from "./release-manifest.mjs";
import {
  createFinalAcceptance,
  summarizeFinalAcceptance,
} from "../qualification/final-acceptance.mjs";

test("pending pair blocks normal clients; only matching validation enters until commit", async () => {
  const base = path.resolve("output/combined-admission-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  await assertCombinedAdmission(root);
  const id = "a".repeat(64);
  const directory = path.join(root, "update/combined", id);
  await mkdir(directory, { recursive: true });
  await assert.rejects(assertCombinedAdmission(root));
  let previous = id,
    count = 0;
  const record = async (state) => {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      identitySha256: id,
      previousSha256: previous,
      state,
    });
    await writeFile(path.join(directory, `${String(++count).padStart(2, "0")}.json`), bytes);
    previous = sha256(bytes);
  };
  await record("Prepared");
  await assert.rejects(assertCombinedAdmission(root, id));
  await record("ServiceReady");
  await record("AppSelected");
  await assertCombinedAdmission(root, id);
  await assert.rejects(assertCombinedAdmission(root));
  await assert.rejects(assertCombinedAdmission(root, "b".repeat(64)));
  await record("DesktopReady");
  await record("Committing");
  await record("Committed");
  await assertCombinedAdmission(root);
  await assert.rejects(assertCombinedAdmission(root, id));
  await writeFile(path.join(directory, "02.json"), "{}");
  await assert.rejects(assertCombinedAdmission(root));
});

test("final acceptance never promotes a different candidate or historical fixture", () => {
  const candidate = { setupSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
  const input = createFinalAcceptance(candidate);
  assert.equal(summarizeFinalAcceptance(input).counts.pending, 16);
  for (const gate of input.gates)
    Object.assign(gate, {
      status: "passed",
      scope: "final",
      candidate,
      evidence: ["retained-evidence"],
    });
  assert.equal(summarizeFinalAcceptance(input).ready, true);
  input.gates[0].candidate = { ...candidate, setupSha256: "c".repeat(64) };
  assert.throws(() => summarizeFinalAcceptance(input), /another candidate/);
  input.gates[0].candidate = candidate;
  input.gates[0].scope = "fixture";
  assert.throws(() => summarizeFinalAcceptance(input), /Earlier fixture/);
});
