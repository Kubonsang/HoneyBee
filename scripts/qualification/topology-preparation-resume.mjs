import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readBounded } from "../update/prepare-release.mjs";
import { plainDirectory } from "../update/stage-release.mjs";

// Only this reviewed, pre-staging failure may resume. A job, result or any other
// evidence requires its own review; this never deletes or rewrites the old attempt.
export async function authorizeTopologyPreparationResume(directory, expectedIntent) {
  await plainDirectory(directory);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["failed.json", "intent.json"],
    "Preparation retry requires an attempt without any activation job or extra records",
  );
  const failure = JSON.parse(await readBounded(path.join(directory, "failed.json")));
  assert.equal(failure.schemaVersion, 1);
  assert.equal(failure.automaticReplay, false);
  assert.match(
    failure.error,
    /^AssertionError \[ERR_ASSERTION\]: Service update requires interactive Setup\r?\n\r?\nfalse !== true\r?\n?$/u,
  );
  const intent = JSON.parse(
    await readBounded(path.join(directory, "intent.json"), 8 * 1024 * 1024),
  );
  assert.deepEqual(intent, expectedIntent, "Original preparation intent or user state changed");
  return path.join(directory, "PreparationRetry");
}
