import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../update/release-manifest.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
export async function reviewCancelledController(bundle, caseId) {
  assert.equal(caseId, "kill-service-validated");
  const matrix = path.join(bundle, "Matrix");
  const attempts = (await readdir(matrix)).filter((n) => n.startsWith(caseId + "-attempt-")).sort();
  assert(attempts.length === 1 || attempts.length === 2);
  assert.equal(attempts[0], caseId + "-attempt-000");
  if (attempts.length === 2) {
    assert.equal(attempts[1], caseId + "-attempt-001");
    const preflight = path.join(matrix, attempts[1]);
    await plainDirectory(preflight);
    const names = (await readdir(preflight)).sort();
    if (names.includes("interrupted.json")) {
      assert.deepEqual(names, [
        "failed.json",
        "identity.json",
        "interrupted.json",
        "native-ready.json",
        "reached.json",
        "started.json",
        "worker-exit.json",
        "worker.json",
      ]);
      const json = async (file) => JSON.parse(await readFile(file, "utf8"));
      const workerBytes = await readFile(path.join(preflight, "worker.json"));
      assert.equal(
        sha256(workerBytes),
        "dafaa3e6f2cd3ca0763497acb5293b0f5225ddc6d9707478ceeb1fc967088ea2",
      );
      const worker = JSON.parse(workerBytes);
      const interrupted = await json(path.join(preflight, "interrupted.json"));
      assert.equal(interrupted.proof.reached, true);
      assert.equal(interrupted.proof.point, "service-validated");
      assert.equal(interrupted.proof.evidence.native.state, "ReadyForAppCommit");
      assert.equal(
        interrupted.proof.evidence.native.migrationName,
        "migration-7e4fa795af0a95671279e1d1ca722f6f",
      );
      assert.equal((await json(path.join(preflight, "worker-exit.json"))).code, 197);
      assert(/^job-[A-Za-z0-9]+$/.test(worker.job.name));
      const requestBytes = await readFile(
        path.join(worker.installationRoot, "update/jobs", worker.job.name, "request.json"),
      );
      assert.equal(sha256(requestBytes), worker.job.sha256);
      assert.equal(
        sha256(await readFile(path.join(worker.installationRoot, "current.json"))),
        JSON.parse(requestBytes).sourcePointerSha256,
      );
      const recoveryRoot = path.join(worker.installationRoot, "update/recovery-attempts");
      let rolledBack = false;
      for (const name of await readdir(recoveryRoot)) {
        if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
        let result;
        try {
          result = await json(path.join(recoveryRoot, name, "result.json"));
        } catch (e) {
          if (e.code === "ENOENT") continue;
          throw e;
        }
        if (
          result.ok === true &&
          result.result?.state === "RolledBack" &&
          result.result.transactionDirectory ===
            path.join(
              worker.installationRoot,
              "update/combined/a7009017cc1fe2185d06851ea305e41ee4239dc3cccbeab7762b7b14397671df",
            )
        )
          rolledBack = true;
      }
      assert(rolledBack, "Recorded automatic rollback required before affected-case retry");
    } else assert.deepEqual(names, ["failed.json", "identity.json"]);
    const failure = JSON.parse(await readFile(path.join(preflight, "failed.json"), "utf8"));
    assert.match(failure.error, /honeybee\.exe doctor --json/);
    assert.equal(failure.identity.scenario.id, caseId);
  }
  const root = path.join(matrix, caseId + "-attempt-000");
  await plainDirectory(root);
  assert.deepEqual((await readdir(root)).sort(), [
    "failed.json",
    "identity.json",
    "started.json",
    "worker.json",
  ]);
  const failed = JSON.parse(await readFile(path.join(root, "failed.json"), "utf8"));
  assert.match(failed.error, /launch-native-fault\.ps1/);
  assert.match(failed.error, /The operation was canceled by the user/);
  assert.equal(
    sha256(await readFile(path.join(root, "worker.json"))),
    "c54f1e272878a087698411c2878265914401ccad8670a5057023107b241db471",
  );
}
