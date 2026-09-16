import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readBounded } from "../update/prepare-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { authenticateReleaseManifest } from "../update/release-authentication.mjs";
import { activateAuthenticatedUpdate } from "../update/activate-authenticated.mjs";
import {
  activateInstalledCombinedUpdate,
  runCombinedApplicationTransaction,
} from "../update/installed-combined-update.mjs";
import { withApplicationActivity } from "../update/application-activity.mjs";
import { createActivationJob } from "../update/update-job.mjs";
import { prepareMatrixUpdate } from "./prepared-reuse.mjs";
import { createEvidenceWriter } from "./integrated-flow.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";
import { snapshotRegisteredProject, assertPreserved } from "./preservation.mjs";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";
import { authorizeTopologyPreparationResume } from "./topology-preparation-resume.mjs";
import {
  verifyOpticalPredecessor,
  verifyQuiescePredecessor,
  verifyBackupPredecessor,
  verifyCompressionPredecessor,
  verifyActivityPredecessor,
} from "./topology-optical-predecessor.mjs";

// One reviewed transition of the populated original QA installation. This is
// ordinary authenticated preparation + native backup/migration/rollback, driven
// by an external runner so the immutable old recovery runtime need not be edited.
const bundle = path.resolve(import.meta.dirname, "../..");
const optical = ["--optical", "--optical-recover"].includes(process.argv[2]);
const quiesce = ["--quiesce", "--quiesce-recover"].includes(process.argv[2]);
const backup = ["--backup", "--backup-recover"].includes(process.argv[2]);
const activityRetry = ["--activity", "--activity-recover"].includes(process.argv[2]);
const compression =
  activityRetry || ["--compression", "--compression-recover"].includes(process.argv[2]);
const targetVersion = compression
  ? "0.1.0-beta.22"
  : backup
    ? "0.1.0-beta.21"
    : quiesce
      ? "0.1.0-beta.20"
      : optical
        ? "0.1.0-beta.19"
        : "0.1.0-beta.15";
const mediaName = compression
  ? "topology-compression"
  : backup
    ? "topology-backup"
    : quiesce
      ? "topology-quiesce"
      : optical
        ? "topology-optical"
        : "topology-bridge";
const directory = path.join(
  bundle,
  activityRetry
    ? "Transitions/topology6"
    : compression
      ? "Transitions/topology5"
      : backup
        ? "Transitions/topology4"
        : quiesce
          ? "Transitions/topology3"
          : optical
            ? "Transitions/topology2"
            : "Transitions/topology1",
);
let execution = path.join(directory, "Execution");
const json = async (file) => JSON.parse(await readBounded(file, 8 * 1024 * 1024));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(?:GIT_|NODE_|HONEYBEE_)/iu.test(key)),
);
const run = (file, args) =>
  promisify(execFile)(file, args, {
    env,
    windowsHide: true,
    timeout: 1800000,
    maxBuffer: 8 * 1024 * 1024,
  });
let started = false;
try {
  assert.equal(process.platform, "win32");
  assert(
    process.argv.length === 2 ||
      (process.argv.length === 3 &&
        [
          "--recover",
          "--resume-preparation",
          "--optical",
          "--optical-recover",
          "--quiesce",
          "--quiesce-recover",
          "--backup",
          "--backup-recover",
          "--compression",
          "--compression-recover",
          "--activity",
          "--activity-recover",
        ].includes(process.argv[2])),
  );
  const recover = [
    "--recover",
    "--optical-recover",
    "--quiesce-recover",
    "--backup-recover",
    "--compression-recover",
    "--activity-recover",
  ].includes(process.argv[2]);
  const resumePreparation = process.argv[2] === "--resume-preparation";
  if (recover && !optical && !quiesce && !backup && !compression) {
    const retry = path.join(execution, "PreparationRetry");
    const info = await lstat(retry).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (info) {
      assert(info.isDirectory() && !info.isSymbolicLink());
      execution = retry;
    }
  }
  const config = await json(path.join(directory, "transition.json"));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.qualificationOnly, true);
  assert.equal(config.publicationAllowed, false);
  const guest = JSON.parse(
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
  assert.equal(guest.computerName, "DESKTOP-9LT0JVV");
  assert.equal(guest.userSid, "S-1-5-21-4199076252-3622841657-4011401391-1001");
  assert.equal(guest.elevated, false, "Run as the original guest user without elevation");
  const root = guest.installationRoot,
    runtime = path.join(root, "recovery/v1");
  const launcher = path.join(root, "HoneyBeeLauncher.exe");
  const checked = JSON.parse((await run(launcher, ["--verify-recovery-runtime"])).stdout);
  assert.equal(
    checked.recoveryManifestSha256,
    sha256(await readBounded(path.join(runtime, "manifest.json"))),
  );
  const trust = await json(path.join(runtime, "update-trust.json"));
  const media = path.join(bundle, "updates", mediaName);
  const authenticated = authenticateReleaseManifest(
    await readBounded(path.join(media, "release.json")),
    await readBounded(path.join(media, "release.sig.json")),
    trust.publicKeys,
  );
  assert.equal(authenticated.manifestSha256, config.bridgeManifestSha256);
  assert.equal(authenticated.manifest.version, targetVersion);
  assert.equal(
    authenticated.manifest.components.storage.componentVersion,
    compression
      ? "0.0.0+cfa606fd4143.hb13.topology5.qa-baseline"
      : backup
        ? "0.0.0+cfa606fd4143.hb13.topology4.qa-baseline"
        : quiesce
          ? "0.0.0+cfa606fd4143.hb13.topology3.qa-baseline"
          : optical
            ? "0.0.0+cfa606fd4143.hb13.topology2.qa-baseline"
            : "0.0.0+cfa606fd4143.hb13.topology1.qa-baseline",
  );
  assert.equal(authenticated.manifest.components.storage.migration.kind, "service-replacement");
  assert.deepEqual(authenticated.manifest.components.storage.migration.supportedSourceVersions, [
    "0.0.0+cfa606fd4143.hb13.qa-baseline",
  ]);
  assert.equal(
    sha256(await readBounded(path.join(bundle, "inputs.json"), 8 * 1024 * 1024)),
    config.originalInputsSha256,
  );
  const old = await createEvidenceWriter(path.join(bundle, "Evidence"), { resume: true });
  const dataset = old.history.findLast(
    (e) => e.phase === "dataset" && e.state === "Completed",
  )?.result;
  const before = old.history.findLast(
    (e) => e.phase === "baseline-health" && e.state === "Completed",
  )?.result;
  assert(dataset && before, "Original completed dataset and preservation evidence required");
  assert.equal(before.projectId, "25e6825e-4c06-4095-8721-0b4cc2acd985");
  const snapshot = () =>
    snapshotRegisteredProject({ installationRoot: root, projectId: before.projectId });
  assertPreserved(before, await snapshot());
  const pointer = await readBounded(path.join(root, "current.json"));
  let result;
  if (!recover) {
    if (optical || quiesce || backup || compression)
      await (
        activityRetry
          ? verifyActivityPredecessor
          : compression
            ? verifyCompressionPredecessor
            : backup
              ? verifyBackupPredecessor
              : quiesce
                ? verifyQuiescePredecessor
                : verifyOpticalPredecessor
      )({
        bundle,
        installationRoot: root,
        before,
        dataset,
        sourcePointerSha256: config.sourcePointerSha256,
        originalInputsSha256: config.originalInputsSha256,
      });
    assert.equal(sha256(pointer), config.sourcePointerSha256);
    assert.equal(JSON.parse(pointer).activeVersion, "0.1.0-beta.11");
    const receipt = await json(path.join(guest.storeRoot, "install-receipt.json"));
    assert.equal(receipt.executableSha256, config.sourceHost.sha256);
    assert.deepEqual(await digestDistributionFile(receipt.executable), config.sourceHost);
    const doctor = JSON.parse(
      (await run(path.join(root, "bin/honeybee.exe"), ["doctor", "--json"])).stdout,
    );
    assert.equal(doctor.ready, true, "Source Doctor must be ready before transition");
    assert(guest.freeBytes >= 16 * 1024 ** 3, "At least 16 GiB free required");
    const intent = {
      schemaVersion: 1,
      configSha256: sha256(await readBounded(path.join(directory, "transition.json"))),
      before,
      dataset,
      sourcePointerSha256: sha256(pointer),
      bridgeManifestSha256: config.bridgeManifestSha256,
    };
    if (resumePreparation) execution = await authorizeTopologyPreparationResume(execution, intent);
    await mkdir(execution); // preserve every earlier attempt; only one reviewed retry
    started = true;
    await durableQARecord(path.join(execution, "intent.json"), intent);
    process.stdout.write("Preparing authenticated QA transition...\n");
    const prepared = await prepareMatrixUpdate({
      installationRoot: root,
      bundle,
      step: {
        name: mediaName,
        serviceUpdate: true,
        from: "0.1.0-beta.11",
        to: targetVersion,
        manifestSha256: config.bridgeManifestSha256,
      },
    });
    const job = await createActivationJob({ ...prepared, setupActivation: true });
    await durableQARecord(path.join(execution, "job.json"), job);
    const request = await json(path.join(job.directory, "request.json"));
    process.stdout.write("Applying QA transition. Accept the service administrator prompt.\n");
    result = await activateAuthenticatedUpdate(
      {
        installationRoot: root,
        runtime,
        request,
        activationJob: { directory: job.directory, requestSha256: job.sha256 },
      },
      {
        activateCombined: (options) =>
          activateInstalledCombinedUpdate({ ...options, nativeCoordinator: "target" }),
      },
    );
  } else {
    const intent = await json(path.join(execution, "intent.json"));
    assert.equal(
      intent.configSha256,
      sha256(await readBounded(path.join(directory, "transition.json"))),
    );
    assert.deepEqual(intent.before, before);
    const job = await json(path.join(execution, "job.json"));
    assert.equal(path.dirname(job.directory), path.join(root, "update/jobs"));
    assert.equal(sha256(await readBounded(path.join(job.directory, "request.json"))), job.sha256);
    const binding = await json(path.join(job.directory, "combined-transaction.json"));
    assert.equal(binding.requestSha256, job.sha256);
    assert(/^[a-f0-9]{64}$/u.test(binding.identitySha256));
    const context = await json(
      path.join(root, "update/combined-contexts", binding.identitySha256 + ".json"),
    );
    assert.equal(context.identitySha256, binding.identitySha256);
    assert.equal(context.nativeCoordinator, "target");
    assert.equal(context.identity.manifestSha256, config.bridgeManifestSha256);
    assert.equal(context.identity.sourcePointerSha256, config.sourcePointerSha256);
    result = await withApplicationActivity(
      { installationRoot: root, mode: "exclusive", timeoutMs: 30000 },
      (activity) =>
        runCombinedApplicationTransaction({ root, runtime, context, activity, recover: true }),
    );
    await run(launcher, []);
  }
  assert(["Committed", "RolledBack"].includes(result.state));
  assertPreserved(before, await snapshot());
  const doctor = JSON.parse(
    (await run(path.join(root, "bin/honeybee.exe"), ["doctor", "--json"])).stdout,
  );
  assert.equal(doctor.ready, true);
  const current = await json(path.join(root, "current.json"));
  assert.equal(
    current.activeVersion,
    result.state === "Committed" ? targetVersion : "0.1.0-beta.11",
  );
  const receipt = await json(path.join(guest.storeRoot, "install-receipt.json"));
  const expected = result.state === "Committed" ? config.targetHost : config.sourceHost;
  assert.equal(receipt.executableSha256, expected.sha256);
  assert.deepEqual(await digestDistributionFile(receipt.executable), expected);
  const record = {
    schemaVersion: 1,
    state: result.state,
    before,
    dataset,
    current,
    receipt,
    bridgeManifestSha256: config.bridgeManifestSha256,
    originalInputsSha256: config.originalInputsSha256,
    preserved: true,
    doctor,
    result,
    acceptancePromoted: false,
    publicationAllowed: false,
  };
  await durableQARecord(
    path.join(execution, recover ? "recovery-result.json" : "result.json"),
    record,
  );
  process.stdout.write(
    JSON.stringify({
      state: result.state,
      reason: result.reason,
      transactionDirectory: result.transactionDirectory,
      currentVersion: current.activeVersion,
      preserved: true,
      doctorReady: doctor.ready,
    }) + "\n",
  );
  assert.equal(
    result.state,
    "Committed",
    "Transition rolled back safely; no qualification was resumed",
  );
  process.stdout.write("QA baseline transition PASSED; original data and evidence preserved.\n");
} catch (error) {
  if (started)
    await durableQARecord(path.join(execution, "failed.json"), {
      schemaVersion: 1,
      error: String(error),
      automaticReplay: false,
    }).catch(() => {});
  process.stderr.write(
    String(error) + "\nTransition stopped; retain evidence. No automatic retry.\n",
  );
  process.exitCode = 1;
}
