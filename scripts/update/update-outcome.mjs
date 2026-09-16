import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { readActivationOutcome } from "./app-activation.mjs";
import { readCombinedOutcome } from "./combined-update.mjs";

export async function trackActivationJob(root, job) {
  root = path.resolve(root);
  assert(/^job-[A-Za-z0-9]+$/u.test(job.name) && /^[a-f0-9]{64}$/u.test(job.sha256));
  const directory = path.join(root, "update");
  await plainDirectory(directory);
  const temporary = path.join(directory, `.latest-activation-${randomUUID()}.partial`);
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(JSON.stringify({ schemaVersion: 1, name: job.name, sha256: job.sha256 }));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path.join(directory, "latest-activation.json"));
}

const status = (state, version = null) => ({ schemaVersion: 1, state, version, mandatory: false });
/** Read-only display evidence; never resumes a job or grants update authority. */
export async function readUpdateOutcome(installationRoot) {
  const root = path.resolve(installationRoot),
    marker = path.join(root, "update/latest-activation.json");
  let bytes;
  try {
    bytes = await readBounded(marker, 4096);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    return status("Unresolved");
  }
  try {
    await plainDirectory(path.dirname(marker));
    const job = JSON.parse(bytes);
    assert(
      job.schemaVersion === 1 &&
        /^job-[A-Za-z0-9]+$/u.test(job.name) &&
        /^[a-f0-9]{64}$/u.test(job.sha256),
    );
    const directory = path.join(root, "update/jobs", job.name);
    await plainDirectory(directory);
    const requestBytes = await readBounded(path.join(directory, "request.json"));
    assert.equal(sha256(requestBytes), job.sha256);
    const request = JSON.parse(requestBytes);
    assert(
      request.schemaVersion === 1 && ["activate", "setup-activate"].includes(request.operation),
    );
    let result;
    try {
      result = JSON.parse(await readBounded(path.join(directory, "result.json")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (result === undefined || result.passed === false) {
      // Recovery does not rewrite the original failed/interrupted job. Display
      // the bound terminal combined journal after the Launcher has recovered it.
      let binding;
      try {
        binding = JSON.parse(
          await readBounded(path.join(directory, "combined-transaction.json"), 4096),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (binding) {
        assert(
          binding.schemaVersion === 1 &&
            binding.requestSha256 === job.sha256 &&
            /^[a-f0-9]{64}$/u.test(binding.identitySha256),
        );
        const checked = await readCombinedOutcome({
          installationRoot: root,
          transactionDirectory: path.join(root, "update/combined", binding.identitySha256),
          sourcePointerSha256: request.sourcePointerSha256,
        });
        assert.deepEqual(await readBounded(marker, 4096), bytes, "A newer update job exists");
        return status(checked.state === "Committed" ? "Updated" : "RolledBack", checked.version);
      }
    }
    assert(result, "Update job has no completion evidence");
    assert(result.schemaVersion === 1 && result.requestSha256 === job.sha256);
    let outcome;
    if (result.passed === false) {
      assert.equal(
        sha256(await readBounded(path.join(root, "current.json"))),
        request.sourcePointerSha256,
      );
      outcome = status("Failed");
    } else {
      assert.equal(result.passed, true);
      const completed = result.result;
      if (completed.state === "Cancelled") {
        assert.equal(
          sha256(await readBounded(path.join(root, "current.json"))),
          request.sourcePointerSha256,
        );
        outcome = status("UpdateCancelled");
      } else {
        assert(["Committed", "RolledBack"].includes(completed.state));
        const checked = await (
          completed.kind === "combined" ? readCombinedOutcome : readActivationOutcome
        )({
          installationRoot: root,
          transactionDirectory: completed.transactionDirectory,
          sourcePointerSha256: request.sourcePointerSha256,
        });
        assert.equal(checked.state, completed.state);
        outcome = status(
          completed.restart === "Failed"
            ? "Failed"
            : checked.state === "Committed"
              ? "Updated"
              : "RolledBack",
          checked.version,
        );
      }
    }
    assert.deepEqual(await readBounded(marker, 4096), bytes, "A newer update job exists");
    return outcome;
  } catch {
    return status("Unresolved");
  }
}
