import assert from "node:assert/strict";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digestFile, readJson } from "./release-verification.mjs";

const nativeCases = [
  [
    "TestDifferencingChildGeometry",
    "go:github.com/Kubonsang/unity-workspace-storage/storage:TestDifferencingChildGeometry",
  ],
  [
    "TestDifferencingParentLongPath",
    "go:github.com/Kubonsang/unity-workspace-storage/storage:TestDifferencingParentLongPath",
  ],
  [
    "TestNativeChildGeometry",
    "go:github.com/Kubonsang/HoneyBee/tools/workspace-storage-host/cmd/honeybee-vhdx-bench:TestNativeChildGeometry",
  ],
];
const lifecycleId =
  "go:github.com/Kubonsang/unity-workspace-storage/workspace:TestExternalBeeNativeLifecycle";
const installedUserId =
  "go:github.com/Kubonsang/unity-workspace-storage/workspace:TestInstalledUserCanWriteMountedParent";
const deterministicCases = [
  "vitest:packages/core/src/workspace-storage-timeout.test.ts:responsive service heartbeats do not hide stalled worker progress",
  "vitest:packages/core/src/workspace-storage-timeout.test.ts:reconciles lost response without resubmitting commit or abort",
  "vitest:packages/core/src/workspace-storage-timeout.test.ts:preserves uncertainty after disconnect",
  "vitest:packages/core/src/workspace-storage-timeout.test.ts:preserves uncertainty after restart",
  "vitest:packages/core/src/workspace-storage-timeout.test.ts:rejects completed results for another request",
  "go:github.com/Kubonsang/unity-workspace-storage/workspace:TestCommitObservationReadOnlyAuthenticated",
  "go:github.com/Kubonsang/unity-workspace-storage/workspace:TestCommitObservationTracksWorkerNotPolls",
];

/** Compose only verified existing evidence; this does not execute native tests. */
export async function composeBeta36Native(inputPath, outputPath) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const outputRoot = path.join(root, "output") + path.sep;
  const resolvedOutputRoot = (await realpath(path.join(root, "output"))) + path.sep;
  const inputFile = path.resolve(inputPath);
  const outputFile = path.resolve(outputPath);
  assert(
    inputFile.startsWith(outputRoot) && outputFile.startsWith(outputRoot),
    "Evidence paths must stay under output",
  );
  assert(
    (await realpath(path.dirname(outputFile))).startsWith(resolvedOutputRoot),
    "Output resolves outside owned output",
  );
  const input = await readJson(inputFile);
  assert.equal(input.schemaVersion, 1);
  assert(/^[a-f0-9]{40}$/u.test(input.source?.commit));
  assert(/^[a-f0-9]{64}$/u.test(input.source?.inventorySha256));
  for (const key of ["setupSha256", "manifestSha256"])
    assert(/^[a-f0-9]{64}$/u.test(input.candidate?.[key]));
  const paths = Object.fromEntries(
    ["geometry", "lifecycle", "installedUser", "largeCache", "setupUpdate", "windows"].map(
      (key) => {
        const file = path.resolve(path.dirname(inputFile), input[key] ?? "");
        assert(file.startsWith(outputRoot), `Invalid ${key} path`);
        return [key, file];
      },
    ),
  );
  const evidence = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, file]) => {
        assert((await lstat(file)).isFile(), `Missing ${key} receipt`);
        assert((await realpath(file)).startsWith(resolvedOutputRoot), `Escaping ${key} receipt`);
        return [key, await readJson(file)];
      }),
    ),
  );
  const { geometry, lifecycle, installedUser, largeCache, setupUpdate, windows } = evidence;
  const sameSource = (value) => assert.deepEqual(value, input.source, "Evidence source mismatch");
  sameSource(geometry.source);
  sameSource(lifecycle.source);
  sameSource({
    commit: installedUser.sourceCommit,
    inventorySha256: installedUser.sourceInventorySha256,
  });
  sameSource({
    commit: largeCache.sourceCommit,
    inventorySha256: largeCache.sourceInventorySha256,
  });
  sameSource(windows.source);
  assert.equal(setupUpdate.sourceInventorySha256, input.source.inventorySha256);
  assert.equal(setupUpdate.setupSha256, input.candidate.setupSha256);
  assert.equal(geometry.ok, true);
  assert.equal(geometry.environment?.filesystem, "NTFS");
  assert.equal(lifecycle.ok, true);
  assert.equal(lifecycle.environment, "physical-host");
  assert.equal(lifecycle.computer, geometry.environment.computer);
  assert.equal(lifecycle.protectedHashesUnchanged, true);
  assert.equal(lifecycle.serviceAfter, "Running");
  assert.equal(installedUser.ok, true);
  assert.equal(installedUser.installedUserWritePassed, true);
  assert.equal(installedUser.worker?.elevated, false);
  assert.equal(installedUser.worker?.binarySha256, lifecycle.binarySha256);
  assert.equal(largeCache.ok, true);
  assert.equal(largeCache.largeCacheNormalPathPassed, true);
  for (const item of [installedUser, largeCache, setupUpdate]) {
    assert.equal(item.originalRestored, true);
    assert.equal(item.originalServiceRunning, true);
  }
  assert.equal(installedUser.restoredStatus?.pendingCount, 0);
  assert.equal(largeCache.restoredStatus?.pendingCount, 0);
  assert.equal(setupUpdate.originalStatusAfter?.pendingCount, 0);
  assert.equal(setupUpdate.ok, true);
  assert.equal(setupUpdate.setupRun, true);
  assert.equal(setupUpdate.qaUpdatePassed, true);
  assert.equal(setupUpdate.setupExitCode, 0);
  assert.equal(setupUpdate.doctorExitCode, 0);
  assert.equal(windows.lane, "windows");
  assert.equal(windows.status, "passed");
  for (const id of deterministicCases)
    assert(windows.coverage?.passed?.includes(id), `Deterministic commit case missing: ${id}`);
  const suite = windows.attachments?.find((item) => item.path === "windows-suite.log");
  assert(suite, "Windows deterministic-test log attachment missing");
  const suitePath = path.join(path.dirname(paths.windows), suite.path);
  assert.equal(await digestFile(suitePath), suite.sha256, "Windows deterministic-test log changed");
  const doctorPath = path.join(path.dirname(paths.setupUpdate), "doctor.json");
  assert.equal((await readJson(doctorPath)).ok, true, "Installed Setup Doctor failed");
  const passed = [];
  for (const [name, id] of nativeCases) {
    const test = geometry.tests.find((item) => item.name === name);
    assert(test?.passed && test.exitCode === 0, `Native case failed: ${name}`);
    const log = path.join(path.dirname(paths.geometry), `${name}.log`);
    assert.equal(await digestFile(log), test.logSha256, `Native log changed: ${name}`);
    passed.push(id);
  }
  assert(lifecycle.coveragePassed?.includes(lifecycleId) && lifecycle.exitCode === 0);
  assert.equal(
    await digestFile(
      path.join(path.dirname(paths.lifecycle), "TestExternalBeeNativeLifecycle.log"),
    ),
    lifecycle.logSha256,
  );
  passed.push(lifecycleId, installedUserId);
  const campaignPath = path.join(path.dirname(paths.largeCache), "campaign-result.json");
  assert.equal(await digestFile(campaignPath), largeCache.worker?.campaignSha256);
  const campaign = await readJson(campaignPath);
  assert.equal(campaign.ok, true);
  assert.equal(campaign.normalPathPassed, true);
  assert.equal(campaign.longCommitEvidence, true);
  assert.equal(campaign.normalHeartbeatEvidence, true);
  for (const gate of [campaign.gates?.cli, campaign.gates?.desktop]) {
    assert(gate?.completed && gate.above120Seconds && gate.progressObserved && gate.noAbort);
    assert(gate.heartbeatSamples > 0 && gate.progressAdvances > 0);
  }
  // The campaign explicitly did not run host fault scenarios. The changed
  // failure behavior is owned by the exact-source deterministic Windows suite.
  assert.equal(campaign.heartbeatFaultScenariosPassed, false);
  const attachmentFiles = [
    ...Object.values(paths),
    campaignPath,
    suitePath,
    doctorPath,
    ...nativeCases.map(([name]) => path.join(path.dirname(paths.geometry), `${name}.log`)),
    path.join(path.dirname(paths.lifecycle), "TestExternalBeeNativeLifecycle.log"),
  ];
  const attachments = await Promise.all(
    attachmentFiles.map(async (file) => ({
      path: file,
      sha256: await digestFile(file),
    })),
  );
  const receipt = {
    schemaVersion: 1,
    lane: "native",
    source: input.source,
    candidate: input.candidate,
    status: "passed",
    environment: { kind: "physical-host", computer: lifecycle.computer, filesystem: "NTFS" },
    completedAt: largeCache.finished,
    unexpectedSkips: 0,
    coverage: { passed, deferred: [], unexpectedSkips: 0 },
    updateLaunchPassed: true,
    pendingTransactions: 0,
    regressions: ["issue46-large-cache", "native-commit-heartbeat"],
    regressionMethods: {
      "issue46-large-cache": "physical-host CLI/Desktop normal path",
      "native-commit-heartbeat":
        "same-source deterministic failure injection plus physical-host long normal commits; no host service fault claimed",
    },
    attachments,
  };
  await writeFile(outputFile, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await composeBeta36Native(process.argv[2], process.argv[3])
    .then((receipt) => {
      process.stdout.write(
        JSON.stringify({
          status: receipt.status,
          cases: receipt.coverage.passed.length,
          regressions: receipt.regressions,
        }) + "\n",
      );
    })
    .catch((error) => {
      process.stderr.write(error.stack + "\n");
      process.exitCode = 1;
    });
