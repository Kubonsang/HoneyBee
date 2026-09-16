import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createPrepareJob, createActivationJob } from "./update-job.mjs";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { trackActivationJob } from "./update-outcome.mjs";

const launch = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: path.dirname(executable),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Update preparation worker failed; evidence retained")),
    );
  });

// Completion is display evidence only; it never authorizes activation.
export async function dispatchPreparation({ installationRoot, stage }, { run = launch } = {}) {
  assert.equal(stage.state, "Verified");
  assert.equal(stage.activationAllowed, false);
  const root = path.resolve(installationRoot);
  const job = await createPrepareJob({
    installationRoot: root,
    stageAttempt: stage.attempt,
    manifestSha256: stage.manifestSha256,
  });
  await run(path.join(root, "HoneyBeeLauncher.exe"), ["--update-job", job.name, job.sha256]);
  await plainDirectory(job.directory);
  const requestBytes = await readBounded(path.join(job.directory, "request.json"));
  assert.equal(sha256(requestBytes), job.sha256);
  const request = JSON.parse(requestBytes);
  const completed = JSON.parse(await readBounded(path.join(job.directory, "result.json")));
  assert.equal(completed.schemaVersion, 1);
  assert.equal(completed.passed, true);
  assert.equal(completed.requestSha256, job.sha256);
  const result = completed.result;
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.state, "ReadyForActivation");
  assert.equal(result.activationAllowed, false);
  assert.equal(result.version, stage.version);
  assert.equal(result.manifestSha256, stage.manifestSha256);
  assert.equal(result.signerKeyId, stage.signerKeyId);
  assert.equal(path.resolve(result.stageAttempt), path.resolve(stage.attempt));
  assert.equal(result.sourcePointerSha256, request.sourcePointerSha256);
  assert.equal(
    sha256(await readBounded(path.join(root, "current.json"))),
    request.sourcePointerSha256,
  );
  return { name: job.name, sha256: job.sha256 };
}

export async function dispatchActivation(options) {
  const job = await createActivationJob(options);
  await trackActivationJob(options.installationRoot, job);
  await launch(path.join(path.resolve(options.installationRoot), "HoneyBeeLauncher.exe"), [
    "--update-job",
    job.name,
    job.sha256,
  ]);
  const result = JSON.parse(await readBounded(path.join(job.directory, "result.json")));
  assert(
    result.schemaVersion === 1 && result.passed === true && result.requestSha256 === job.sha256,
  );
  assert(["Committed", "RolledBack", "Cancelled"].includes(result.result?.state));
  assert.notEqual(
    result.result.restart,
    "Failed",
    "Update finished but Desktop restart failed; evidence retained",
  );
  return result.result.state;
}
