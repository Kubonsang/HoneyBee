import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { authorizeTopologyPreparationResume } from "./topology-preparation-resume.mjs";

async function fixture() {
  const base = path.resolve("output/topology-resume-tests");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "case-"));
  const intent = { schemaVersion: 1, configSha256: "original", before: { registrySha256: "same" } };
  let error;
  try {
    assert.equal(false, true, "Service update requires interactive Setup");
  } catch (e) {
    error = String(e);
  }
  await writeFile(path.join(directory, "intent.json"), JSON.stringify(intent));
  await writeFile(
    path.join(directory, "failed.json"),
    JSON.stringify({ schemaVersion: 1, error, automaticReplay: false }),
  );
  return { directory, intent };
}
test("known pre-staging failure resumes to a new directory and preserves original records", async () => {
  const f = await fixture(),
    file = path.join(f.directory, "failed.json"),
    before = await readFile(file);
  assert.equal(
    await authorizeTopologyPreparationResume(f.directory, f.intent),
    path.join(f.directory, "PreparationRetry"),
  );
  assert.deepEqual(await readFile(file), before);
  await mkdir(path.join(f.directory, "PreparationRetry"));
  await assert.rejects(authorizeTopologyPreparationResume(f.directory, f.intent));
});
test("activation job or changed intent cannot use preparation retry", async () => {
  const f = await fixture();
  await assert.rejects(
    authorizeTopologyPreparationResume(f.directory, { ...f.intent, before: {} }),
    /intent or user state changed/,
  );
  await writeFile(path.join(f.directory, "job.json"), "{}");
  await assert.rejects(
    authorizeTopologyPreparationResume(f.directory, f.intent),
    /without any activation job/,
  );
});
test("unrelated failure cannot use the reviewed resume", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.directory, "failed.json"),
    JSON.stringify({ schemaVersion: 1, error: "UAC cancelled", automaticReplay: false }),
  );
  await assert.rejects(authorizeTopologyPreparationResume(f.directory, f.intent));
});
