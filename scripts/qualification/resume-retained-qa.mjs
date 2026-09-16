import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { readBounded } from "../update/prepare-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";
import { snapshotRegisteredProject } from "./preservation.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";
import { reconnectRetained } from "./retained-reconnect.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = async (file) =>
  JSON.parse((await readBounded(file, 8 * 1024 * 1024)).toString().replace(/^\uFEFF/u, ""));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(GIT_|NODE_|HONEYBEE_)/iu.test(key)),
);
const run = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.message += `\nstdout: ${stdout}\nstderr: ${stderr}`;
          reject(error);
        } else resolve(JSON.parse(stdout.replace(/^\uFEFF/u, "")));
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
let evidence;
try {
  assert.equal(root.toLowerCase(), "c:\\honeybeeqa\\final-integrated-20260914");
  const guest = await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "scripts/qualification/inspect-integrated-guest.ps1"),
  ]);
  assert.equal(guest.computerName, "DESKTOP-9LT0JVV");
  assert.equal(guest.userSid, "S-1-5-21-4199076252-3622841657-4011401391-1001");
  assert.equal(guest.elevated, false);
  assert.equal(guest.service?.State, "Running");
  const inputs = await json(path.join(root, "inputs.json"));
  const current = await json(path.join(guest.installationRoot, "current.json"));
  assert.equal(current.activeVersion, "0.1.0-beta.11");
  const receipt = await json(path.join(guest.storeRoot, "install-receipt.json"));
  assert.equal(receipt.userSid, guest.userSid);
  assert.equal(receipt.componentVersion, "0.0.0+cfa606fd4143.hb13.qa-baseline");
  assert.deepEqual(
    await digestDistributionFile(receipt.executable),
    inputs.servicePair.source.host,
  );
  const companion = path.join(
    guest.installationRoot,
    "versions",
    current.activeVersion,
    "tools/honeybee-workspace-storage-host.exe",
  );
  assert.deepEqual(await digestDistributionFile(companion), inputs.servicePair.source.host);
  const names = (await readdir(path.join(root, "Evidence"))).sort();
  const history = [];
  for (const [i, name] of names.entries()) {
    assert.equal(name, `${String(i).padStart(3, "0")}.json`);
    history.push(await json(path.join(root, "Evidence", name)));
  }
  const initial = history.find((e) => e.phase === "preflight" && e.state === "Completed").result;
  assert.deepEqual(initial.candidate, inputs.candidate);
  assert.equal(initial.inputsSha256, sha256(await readBounded(path.join(root, "inputs.json"))));
  const before = history.find(
    (e) => e.phase === "baseline-health" && e.state === "Completed",
  ).result;
  assert.equal(before.projectId, "25e6825e-4c06-4095-8721-0b4cc2acd985");
  assert.equal(before.workspaces.length, 1);
  const workspace = before.workspaces[0];
  assert.equal(workspace.workspaceId, "8934fa61-ed64-4851-8535-261ce5109487");
  assert.equal(workspace.leaseId, "lease-43d0116a8935f0e309d631b1488da3b2");
  assert.deepEqual(
    await readdir(path.join(root, "Matrix")),
    ["kill-service-backup-verified-attempt-000"],
    "A later case exists; do not alter it",
  );
  const journal = await json(
    path.join(guest.storeRoot, guest.userSid, "leases", workspace.leaseId + ".json"),
  );
  evidence = path.join(root, "Diagnostics", "retained-reconnect-" + randomUUID());
  await mkdir(evidence, { recursive: true });
  const record = (name, value) => durableQARecord(path.join(evidence, name + ".json"), value);
  await record("before", { guest, current, receipt, journal, preservation: before });
  const result = await reconnectRetained({
    before,
    workspace,
    journal,
    snapshot: () =>
      snapshotRegisteredProject({
        installationRoot: guest.installationRoot,
        projectId: before.projectId,
      }),
    control: (request) =>
      run(
        companion,
        ["control"],
        JSON.stringify({
          schemaVersion: 3,
          requestId: "qa-reconnect-" + randomUUID(),
          clientPid: process.pid,
          ...request,
        }) + "\n",
      ),
    record,
    doctor: () => run(path.join(guest.installationRoot, "bin/honeybee.exe"), ["doctor", "--json"]),
  });
  await record("result", result);
  console.log(JSON.stringify({ ...result, evidence }, null, 2));
} catch (error) {
  if (evidence)
    await durableQARecord(path.join(evidence, "failed.json"), {
      error: String(error),
      automaticReplay: false,
    });
  console.error(
    JSON.stringify({ restored: false, error: String(error), evidence, automaticReplay: false }),
  );
  process.exitCode = 1;
}
