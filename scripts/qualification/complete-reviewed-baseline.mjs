import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyPublishedSetup } from "../installation/fresh-install.mjs";
import { createEvidenceWriter } from "./integrated-flow.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";
import { sha256 } from "../update/release-manifest.mjs";

const bundle = path.resolve(import.meta.dirname, "../..");
const json = async (file) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const run = (file, args) =>
  promisify(execFile)(file, args, {
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
const optional = async (file) => {
  try {
    return await json(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const record = await createEvidenceWriter(path.join(bundle, "Evidence"), { resume: true });
if (record.history.some((e) => e.phase === "baseline-setup" && e.state === "Completed"))
  process.exit(0);
assert.deepEqual(
  record.history.map((e) => [e.phase, e.state]),
  [
    ["preflight", "Started"],
    ["preflight", "Completed"],
    ["baseline-setup", "Started"],
    ["baseline-setup", "Failed"],
  ],
  "Only the reviewed pre-dataset baseline failure may continue",
);
const inputs = await json(path.join(bundle, "inputs.json"));
assert.equal(
  sha256(await readFile(path.join(bundle, "inputs.json"))),
  record.history[1].result.inputsSha256,
);
assert.equal(inputs.servicePair.source.version, "0.1.0-beta.31");
assert.equal(
  inputs.servicePair.source.host.sha256,
  "6d46f260e1639e732d0b3d316c75c81bc07b12344aea2060adc5324e249fc2a7",
);
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
const state = await inspect();
const guest = await json(path.join(bundle, "guest.json"));
assert.equal(state.computerName, guest.computerName);
assert.equal(state.userSid, guest.userSid);
assert.equal(state.elevated, false);
assert.equal(state.service, null, "Existing service must not be replaced");
const root = state.installationRoot;
assert.equal((await realpath(root)).toLowerCase(), path.resolve(root).toLowerCase());
const pending = path.join(root, ".setup-pending");
const health = await json(path.join(pending, "health.json"));
assert.equal(health.ready, false);
assert.equal(health.serviceAction, "none");
assert.equal(
  health.reason,
  "The installed service does not match this HoneyBee installation. Run Doctor before adopting or using managed tools.",
);
assert(health.prerequisites.some((p) => p.code === "git.executable" && p.status === "pass"));
const registry = await optional(path.join(root, "workspace-core/workspace-registry-v2.json"));
if (registry) {
  assert.equal(registry.schemaVersion, 2);
  assert.deepEqual(registry.projects, []);
  assert.deepEqual(registry.workspaces, []);
}
for (const folder of [path.join(root, "Workspaces"), state.storeRoot]) {
  try {
    assert.equal((await readdir(folder)).length, 0, "Expected empty fixture storage");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const inventory = await json(path.join(bundle, "reviewed-baseline-inventory.json"));
await verifyPublishedSetup({ target: root, inventory });
const release = path.join(root, "versions/0.1.0-beta.31");
const core = await import(
  pathToFileURL(path.join(release, "cli/node_modules/@honeybee/core/dist/index.js")).href
);
const tools = new core.WorkspaceToolResolver(await core.readInstalledStorage(release)).resolve();
await core.validateStorageTools(tools);
assert.equal(sha256(await readFile(tools.controlCommand)), inputs.servicePair.source.host.sha256);
assert.equal(tools.expectedComponentVersion, inputs.servicePair.source.componentVersion);
const attempt = path.join(bundle, "reviewed-baseline-service-started.json");
await durableQARecord(attempt, {
  schemaVersion: 1,
  reason: "Reviewed silent Setup omitted service installation",
  originalFailure: record.history[3],
  priorHealth: health,
  serviceExisted: false,
  automaticReplay: false,
});
try {
  process.stdout.write(
    "Completing only the missing baseline service. Approve the service UAC prompt.\n",
  );
  await run(tools.controlCommand, [
    "install-elevated",
    "--workspace-root",
    path.join(root, "Workspaces"),
    "--component-version",
    tools.expectedComponentVersion,
  ]);
  await core.requireCompatibleStorage(new core.WindowsWorkspaceStorage(), tools);
  const receipt = await json(path.join(state.storeRoot, "install-receipt.json"));
  assert.equal(receipt.userSid, guest.userSid);
  assert.equal(receipt.componentVersion, inputs.servicePair.source.componentVersion);
  assert.equal(receipt.executableSha256, inputs.servicePair.source.host.sha256);
  assert.equal(sha256(await readFile(receipt.executable)), receipt.executableSha256);
  const after = await inspect();
  assert.equal(after.service.State, "Running");
  assert.equal(after.service.StartName, "LocalSystem");
  const doctor = JSON.parse(
    (await run(path.join(root, "bin/honeybee.exe"), ["doctor", "--json"])).stdout,
  );
  assert.equal(doctor.ready, true);
  assert.equal(doctor.summary.fail, 0);
  await record({
    phase: "baseline-setup",
    state: "Completed",
    result: {
      doctor,
      receipt,
      service: after.service,
      reviewedServiceCompletion: true,
      originalFailurePreserved: true,
    },
  });
  process.stdout.write(
    "Baseline service ready. Original failure retained; continuing the same batch.\n",
  );
} catch (error) {
  await durableQARecord(path.join(bundle, "reviewed-baseline-service-failed.json"), {
    schemaVersion: 1,
    error: String(error),
    code: error.code ?? null,
    stdout: error.stdout ?? null,
    stderr: error.stderr ?? null,
    automaticReplay: false,
  });
  throw error;
}
