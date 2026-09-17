import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createEvidenceWriter } from "./integrated-flow.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { requiredChildReservation } from "./bee-capacity.mjs";
import { retireReviewedSetups } from "./retire-reviewed-setups.mjs";
const bundle = path.resolve(import.meta.dirname, "../..");
const json = async (p) => JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/, ""));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(GIT_|NODE_|HONEYBEE_)/i.test(key)),
);
const run = (file, args) =>
  promisify(execFile)(file, args, {
    env,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
const record = await createEvidenceWriter(path.join(bundle, "Evidence"), { resume: true });
if (record.history.some((e) => e.phase === "dataset" && e.state === "Completed")) process.exit(0);
const failure = record.history.at(-1);
assert.equal(failure.phase, "dataset");
assert.equal(failure.state, "Failed");
assert.match(failure.error, /Workspace storage cannot reserve enough disk space/);
assert.equal(
  record.history.filter((e) => e.phase === "dataset" && e.state === "Started").length,
  1,
);
const inputs = await json(path.join(bundle, "inputs.json"));
assert.equal(
  sha256(await readFile(path.join(bundle, "inputs.json"))),
  record.history.find((e) => e.phase === "preflight" && e.state === "Completed").result
    .inputsSha256,
);
const inspect = JSON.parse(
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
const pin = await json(path.join(bundle, "guest.json"));
assert.equal(inspect.computerName, pin.computerName);
assert.equal(inspect.userSid, pin.userSid);
assert.equal(inspect.elevated, false);
assert.equal(inspect.service?.State, "Running");
const root = inspect.installationRoot;
const receipt = await json(path.join(inspect.storeRoot, "install-receipt.json"));
assert.equal(receipt.executableSha256, inputs.servicePair.source.host.sha256);
assert.equal(receipt.componentVersion, inputs.servicePair.source.componentVersion);
assert.equal(sha256(await readFile(receipt.executable)), receipt.executableSha256);
assert.equal((await json(path.join(root, "current.json"))).activeVersion, "0.1.0-beta.31");
const registryPath = path.join(root, "workspace-core/workspace-registry-v2.json");
const registry = await json(registryPath);
assert.equal(registry.projects.length, 1);
assert.deepEqual(registry.workspaces, []);
assert.deepEqual(registry.removalReceipts, []);
const entry = registry.projects[0],
  project = path.join(bundle, "QA 데이터", "Unity 프로젝트");
assert.equal(entry.projectId, "a0bdc79b-d319-4702-9ba4-b6af3414fb95");
assert.equal(entry.unityProjectPath, project);
assert.equal(entry.repositoryRoot, project);
assert.equal(entry.workspaceRoot, path.join(bundle, "QA 데이터", "Workspaces"));
assert.equal(
  entry.cache.parentId,
  "76094afe7a5a5a044b7c3b3c70e0ae2d6ec2c34103302691f8d49efe2ecb0db6",
);
assert.equal(entry.cache.seedCommit, "494699a2c870b69c87e68a69c76f6b1f31c9325a");
await plainDirectory(project);
const git = async (args) =>
  (
    await run("git.exe", [
      "-c",
      `safe.directory=${project}`,
      "-c",
      "core.hooksPath=NUL",
      "-C",
      project,
      ...args,
    ])
  ).stdout.trim();
assert.equal(await git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
assert.equal(await git(["rev-parse", "HEAD"]), entry.cache.seedCommit);
assert.equal(await git(["rev-parse", "refs/heads/qa-preserved"]), entry.cache.seedCommit);
assert.equal((await git(["worktree", "list", "--porcelain"])).split("worktree ").length, 2);
const expectedWorkspace = path.join(entry.workspaceRoot, "preserved");
assert.equal(
  await lstat(expectedWorkspace).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  ),
  false,
);
const client = path.join(root, "versions/0.1.0-beta.31/tools/unity-workspace-storage.exe");
const status = JSON.parse(
  (
    await run(client, [
      "workspace",
      "status",
      "--schema",
      "2",
      "--request-id",
      "review-dataset-capacity",
    ])
  ).stdout,
);
assert.equal(status.ok, true);
assert.equal(status.status.parentCount, 1);
assert.equal(status.status.activeLeaseCount, 0);
assert.equal(status.status.quarantineCount, 0);
assert.equal(status.status.manualRecoveryRequired, false);
const config = await json(path.join(inspect.storeRoot, "broker-config.json"));
const metadata = await json(
  path.join(inspect.storeRoot, pin.userSid, "parents", entry.cache.parentId, "metadata.json"),
);
assert(metadata.beeSeed, "Expected external Bee parent metadata");
const reserve = requiredChildReservation(config.childReserveBytes, metadata.beeSeed),
  floor = config.hostFloorBytes,
  quota = config.quotaBytes;
for (const n of [reserve, floor, quota]) assert(Number.isSafeInteger(n) && n > 0);
const capacity = {
  freeBytes: status.status.hostFreeBytes,
  allocatedBytes: status.status.allocatedBytes,
  reserveBytes: reserve,
  floorBytes: floor,
  quotaBytes: quota,
};
process.stdout.write(
  JSON.stringify({ readOnlyCapacity: capacity, beeSeed: metadata.beeSeed }) + "\n",
);
if (capacity.freeBytes - reserve < floor) {
  process.stdout.write(
    "Creating free space by lossless NTFS compression of reviewed installation copies. No files are deleted.\n",
  );
  const compressed = await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(bundle, "scripts/qualification/compress-reviewed-installations.ps1"),
  ]);
  process.stdout.write(compressed.stdout);
  const refreshed = JSON.parse(
    (
      await run(client, [
        "workspace",
        "status",
        "--schema",
        "2",
        "--request-id",
        "review-bee-capacity-" + Date.now(),
      ])
    ).stdout,
  );
  assert.equal(refreshed.ok, true);
  capacity.freeBytes = refreshed.status.hostFreeBytes;
  capacity.allocatedBytes = refreshed.status.allocatedBytes;
}
if (capacity.freeBytes - reserve < floor) {
  await retireReviewedSetups(bundle);
  const refreshed = JSON.parse(
    (
      await run(client, [
        "workspace",
        "status",
        "--schema",
        "2",
        "--request-id",
        "review-retired-capacity-" + Date.now(),
      ])
    ).stdout,
  );
  assert.equal(refreshed.ok, true);
  capacity.freeBytes = refreshed.status.hostFreeBytes;
  capacity.allocatedBytes = refreshed.status.allocatedBytes;
  process.stdout.write(JSON.stringify({ capacityAfterRetirement: capacity }) + "\n");
}
assert(
  capacity.freeBytes - reserve >= floor && capacity.allocatedBytes + reserve <= quota,
  "Current reservation cannot fit; no Workspace retry performed",
);
await durableQARecord(path.join(bundle, "reviewed-dataset-bee-started.json"), {
  schemaVersion: 1,
  capacity,
  originalFailure: failure,
  registry,
  operation: "Attach the preserved qa-preserved branch; reuse existing parent",
  automaticReplay: false,
});
try {
  const cli = async (args) =>
    JSON.parse((await run(path.join(root, "bin/honeybee.exe"), [...args, "--json"])).stdout);
  const created = await cli([
    "workspace",
    "attach",
    "preserved",
    "--branch",
    "qa-preserved",
    "--project",
    entry.projectId,
  ]);
  assert.equal(created.ok, true);
  assert.equal(created.workspace.state, "ready");
  assert.equal(created.workspace.available, true);
  assert.equal(created.workspace.workspacePath, expectedWorkspace);
  assert.equal((await json(registryPath)).projects[0].cache.parentId, entry.cache.parentId);
  for (const worktree of [project, expectedWorkspace]) {
    await plainDirectory(path.join(worktree, "Assets"));
    assert.equal(
      (await readFile(path.join(worktree, "Assets/Source.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "committed source\n",
    );
    await writeFile(path.join(worktree, "Assets/새 파일.txt"), "untracked source\n", {
      flag: "wx",
    });
    await writeFile(path.join(worktree, "Assets/Source.txt"), "dirty tracked source\n");
  }
  const doctor = await cli(["doctor"]);
  assert.equal(doctor.ready, true);
  await record({
    phase: "dataset",
    state: "Completed",
    result: {
      projectId: entry.projectId,
      project,
      workspace: created.workspace,
      cacheSeed: "synthetic-not-Unity-import-qualification",
      reviewedCapacityContinuation: true,
      originalFailurePreserved: true,
    },
  });
  process.stdout.write(
    "Existing project, cache and branch reused. Dataset ready; continuing the same batch.\n",
  );
} catch (error) {
  await durableQARecord(path.join(bundle, "reviewed-dataset-bee-failed.json"), {
    schemaVersion: 1,
    error: String(error),
    stdout: error.stdout ?? null,
    stderr: error.stderr ?? null,
    capacity,
    automaticReplay: false,
  });
  throw error;
}
