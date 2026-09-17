import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  snapshotRegisteredProject,
  assertPreserved,
} from "./scripts/qualification/preservation.mjs";
import {
  runInterruptionMatrix,
  durableQARecord,
  RestartPending,
} from "./scripts/qualification/interruption-matrix.mjs";
import { createWindowsMatrixOperations } from "./scripts/qualification/windows-matrix.mjs";
import { sha256 } from "./scripts/update/release-manifest.mjs";

const bundle = import.meta.dirname;
const root = path.join(process.env.LOCALAPPDATA, "HoneyBee");
const evidence = path.join(bundle, "Evidence");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const optional = async (file) => {
  try {
    return await json(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
};
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(GIT_|NODE_|HONEYBEE_)/iu.test(name)),
);
const run = (file, args) =>
  promisify(execFile)(file, args, {
    env,
    windowsHide: true,
    timeout: 240000,
    maxBuffer: 8 * 1024 ** 2,
  });
await mkdir(evidence, { recursive: true });
const save = (name, value) => durableQARecord(path.join(evidence, `${name}.json`), value);
try {
  assert.equal(
    await optional(path.join(evidence, "failed.json")),
    null,
    "Prior failure retained; no automatic replay",
  );
  const inputs = await json(path.join(bundle, "inputs.json"));
  const inputsSha256 = sha256(await readFile(path.join(bundle, "inputs.json")));
  const adopted = await json(path.join(bundle, "../Evidence-adoption/completed.json"));
  assert.equal(adopted.zipStyleAdoptionPassed, true);
  assert.equal(adopted.projectId, inputs.projectId);
  assert.equal(adopted.setupSha256, inputs.candidate.setupSha256);
  const inspect = async () =>
    JSON.parse(
      (
        await run("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(bundle, "scripts/qualification/inspect-integrated-guest.ps1"),
        ])
      ).stdout,
    );
  const guest = await inspect();
  assert.equal(guest.elevated, false);
  const snapshot = () =>
    snapshotRegisteredProject({ installationRoot: root, projectId: inputs.projectId });
  const receiptFile = path.join(guest.storeRoot, "install-receipt.json");
  let admission = await optional(path.join(evidence, "admission.json"));
  const health = async () => {
    assert.equal((await json(path.join(root, "current.json"))).activeVersion, "0.1.0-beta.32");
    const receipt = await json(receiptFile);
    assert.equal(receipt.componentVersion, inputs.servicePair.target.componentVersion);
    assert.equal(receipt.executableSha256, inputs.servicePair.target.host.sha256);
    assert.equal(sha256(await readFile(receipt.executable)), inputs.servicePair.target.host.sha256);
    const doctor = JSON.parse(
      (await run(path.join(root, "bin/honeybee.exe"), ["doctor", "--json"])).stdout,
    );
    assert.equal(doctor.ready, true);
    if (admission) assert.equal(sha256(await readFile(receiptFile)), admission.receiptSha256);
    return doctor;
  };
  if (!admission) {
    await health();
    await run(path.join(root, "HoneyBeeLauncher.exe"), ["--verify-recovery-runtime"]);
    admission = {
      schemaVersion: 1,
      inputsSha256,
      before: await snapshot(),
      receiptSha256: sha256(await readFile(receiptFile)),
      guest,
    };
    await save("admission", admission);
  }
  assert.equal(admission.inputsSha256, inputsSha256);
  const operations = createWindowsMatrixOperations({
    bundle,
    installationRoot: root,
    inputs,
    health,
    snapshot,
    bootId: async () => (await inspect()).bootTime,
    env,
  });
  const results = [];
  for (const onlyCase of [
    "kill-app-prepared",
    "kill-app-selected",
    "kill-app-validated",
    "rollback-app-health",
    "reboot-app-selected",
  ]) {
    process.stdout.write(`App recovery: ${onlyCase}\n`);
    results.push(
      await runInterruptionMatrix({
        directory: path.join(bundle, "Matrix"),
        kind: "app",
        candidate: { ...inputs.candidate, inputsSha256 },
        before: admission.before,
        dataset: { projectId: inputs.projectId },
        operations,
        onlyCase,
      }),
    );
  }
  assertPreserved(admission.before, await snapshot());
  await health();
  const report = {
    schemaVersion: 1,
    appRecoveryBatchPassed: true,
    cases: results.map((result) => result.results[0].identity.scenario.id),
    preserved: true,
    serviceReceiptUnchanged: true,
    candidate: inputs.candidate,
    evidence,
    acceptancePromoted: false,
    publicationAllowed: false,
  };
  if (!(await optional(path.join(evidence, "completed.json")))) await save("completed", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (error instanceof RestartPending) {
    process.stdout.write(
      "Required app checkpoint reached. This temporary VM will restart in 15 seconds. After sign-in run Run-App-Recovery.ps1 again; completed cases are retained.\n",
    );
    await run("shutdown.exe", [
      "/r",
      "/t",
      "15",
      "/c",
      "HoneyBee app recovery qualification checkpoint",
    ]);
    process.exitCode = 10;
  } else {
    const report = {
      schemaVersion: 1,
      ok: false,
      error: String(error),
      evidence,
      automaticReplay: false,
    };
    if (!(await optional(path.join(evidence, "failed.json")))) await save("failed", report);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}
