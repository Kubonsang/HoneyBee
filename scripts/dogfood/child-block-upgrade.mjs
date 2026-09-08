// Installed broker qualification using disposable children of an existing parent.
// Service installation and physical reboot are separate, explicit operations.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digest, inside, inventory, noLinks, preserved } from "./shared-host-guard.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [phase, stateArgument, parentDigest] = process.argv.slice(2);
assert(["prepare", "upgrade-check", "resume-reboot", "cleanup"].includes(phase));
assert(stateArgument && path.isAbsolute(stateArgument));
const root = inside(path.join(repo, "output"), path.resolve(stateArgument));
await noLinks(root);
const statePath = path.join(root, "state.json");
const host = path.join(repo, "apps/desktop/.tools/win32-x64/honeybee-workspace-storage-host.exe");
const receiptPath = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/install-receipt.json",
);
const registryPath = path.join(
  process.env.LOCALAPPDATA,
  "HoneyBee/workspace-core/workspace-registry-v2.json",
);
const oldVersion = "0.0.0+796514b475be.hb9";
const newVersion = "0.0.0+c238f283ded2.hb10";
const newHostHash = "63a66d74ce24f40f99e5da76d94daf1ad51fda50a562c316239405b90ad8f915";
const json = async (p) => JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/u, ""));
let state;
const save = async () => writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

function run(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd: repo, windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`${path.basename(executable)} failed: ${stderr || error.message}`));
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
async function call(operation, fields = {}) {
  const response = JSON.parse(
    await run(
      host,
      ["control"],
      JSON.stringify({
        schemaVersion: 3,
        operation,
        requestId: randomUUID(),
        clientPid: process.pid,
        ...fields,
      }),
    ),
  );
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response;
}
async function snapshot() {
  const status = (await call("status")).status;
  return { status, inventory: await inventory(receiptPath, status) };
}
async function guard() {
  assert.equal(digest(await readFile(registryPath)), state.registryHash, "User registry changed");
  const current = await snapshot();
  // The receipt changes intentionally on upgrade; compare child preservation separately.
  preserved(
    { ...state.baseline.inventory, receiptHash: current.inventory.receiptHash },
    current.inventory,
    state.children.filter((c) => !c.removed).map((c) => c.leaseId),
    phase === "resume-reboot" || phase === "cleanup",
  );
  return current;
}
async function installed(version) {
  const receipt = await json(receiptPath);
  assert.equal(receipt.componentVersion, version);
  assert.equal(digest(await readFile(receipt.executable)), receipt.executableSha256);
  if (version === newVersion) assert.equal(receipt.executableSha256, newHostHash);
  return receipt;
}
async function journal(child) {
  const p = inside(state.userRoot, path.join(state.userRoot, "leases", `${child.leaseId}.json`));
  const value = await json(p);
  assert.equal(value.runId, child.runId);
  assert.equal(value.workspaceId, child.workspaceId);
  assert.equal(
    path.resolve(value.mountPath),
    path.join(state.workspaceRoot, child.workspaceId, "Library"),
  );
  assert.equal(
    path.resolve(value.childPath),
    path.join(state.userRoot, "children", `${child.leaseId}.vhdx`),
  );
  assert.equal(path.resolve(value.parentPath), state.parentPath);
  return value;
}
async function geometry(child, label) {
  const j = await journal(child);
  const result = JSON.parse(
    await run("python", ["scripts/benchmarks/vhdx/inspect_vhdx.py", j.childPath]),
  );
  const file = result.files[0];
  assert.equal(file.error, undefined);
  assert.equal(file.blockBytes, child.blockBytes);
  child.checks.push({
    label,
    blockBytes: file.blockBytes,
    allocatedBytes: file.allocatedBytes,
    fileIdentity: j.fileIdentity,
    bootSessionId: j.bootSessionId,
  });
  await save();
}
async function create(blockBytes) {
  const workspaceId = `hb-child-block-${randomUUID()}`;
  const workspacePath = inside(state.workspaceRoot, path.join(state.workspaceRoot, workspaceId));
  await noLinks(workspacePath);
  await mkdir(workspacePath);
  const child = {
    workspaceId,
    runId: workspaceId,
    blockBytes,
    marker: `HoneyBee child geometry ${randomUUID()}\n`,
    checks: [],
  };
  state.pendingWorkspace = workspacePath;
  await save();
  const response = await call("acquire", {
    workspaceId,
    runId: child.runId,
    parentKey: state.parentKey,
  });
  child.leaseId = response.lease.leaseId;
  state.children.push(child);
  delete state.pendingWorkspace;
  await save();
  try {
    assert.equal(path.resolve(response.lease.mountPath), path.join(workspacePath, "Library"));
    const marker = path.join(response.lease.mountPath, "honeybee-child-block-probe.txt");
    await writeFile(marker, child.marker, { flag: "wx" });
    assert.equal(await readFile(marker, "utf8"), child.marker);
  } finally {
    await call("release", { leaseId: child.leaseId, retainChild: true });
  }
  child.fileIdentity = (await journal(child)).fileIdentity;
  await geometry(child, "created-and-retained");
}
async function cycle(child, label) {
  const before = await journal(child);
  const response = await call("attach-retained", {
    runId: child.runId,
    workspaceId: child.workspaceId,
  });
  try {
    assert.equal(response.lease.leaseId, child.leaseId);
    assert.equal(
      await readFile(path.join(response.lease.mountPath, "honeybee-child-block-probe.txt"), "utf8"),
      child.marker,
    );
    const after = await journal(child);
    assert.deepEqual(after.fileIdentity, child.fileIdentity);
    assert.equal(after.childPath, before.childPath);
    const target = (await run("mountvol.exe", [after.mountPath, "/L"])).trim().replace(/\\+$/u, "");
    assert.equal(target.toLowerCase(), after.volumeGuid.replace(/\\+$/u, "").toLowerCase());
    await call("heartbeat", { leaseId: child.leaseId });
  } finally {
    await call("release", { leaseId: child.leaseId, retainChild: true });
  }
  await geometry(child, label);
}

if (phase === "prepare") {
  assert(/^[a-f0-9]{64}$/u.test(parentDigest));
  await mkdir(root);
  const receipt = await installed(oldVersion);
  const baseline = await snapshot();
  const userRoot = inside(receipt.storeRoot, path.join(receipt.storeRoot, receipt.userSid));
  const metadata = await json(
    inside(userRoot, path.join(userRoot, "parents", parentDigest, "metadata.json")),
  );
  assert.equal(metadata.compatibilityKey.digest, parentDigest);
  assert.equal(metadata.blockBytes, 2 ** 21);
  state = {
    schemaVersion: 1,
    baseline,
    registryHash: digest(await readFile(registryPath)),
    userRoot,
    workspaceRoot: path.resolve(receipt.workspaceRoot),
    parentPath: path.resolve(metadata.vhdxPath),
    parentKey: metadata.compatibilityKey,
    children: [],
  };
  await save();
  await create(2 ** 21);
  await guard();
  state.prepared = true;
  await save();
} else {
  state = await json(statePath);
  assert(state.prepared);
  await installed(newVersion);
  await guard();
  if (phase === "upgrade-check") {
    assert(!state.upgradePassed && state.children.length === 1);
    await create(2 ** 20);
    for (let i = 0; i < 3; i++)
      for (const child of state.children) await cycle(child, `post-upgrade-${i + 1}`);
    state.preReboot = await guard();
    state.upgradePassed = true;
    await save();
  } else if (phase === "resume-reboot") {
    assert(state.upgradePassed && !state.rebootPassed);
    const current = await snapshot();
    assert.notEqual(
      current.status.bootSessionId,
      state.preReboot.status.bootSessionId,
      "A new physical Windows boot is required",
    );
    for (const child of state.children) await cycle(child, "physical-reboot");
    await guard();
    state.rebootPassed = true;
    await save();
  } else {
    assert(state.rebootPassed, "Preserve fixtures until physical reboot verification finishes");
    for (const child of state.children) {
      if (child.removed) continue;
      await cycle(child, "pre-cleanup");
      const j = await journal(child);
      const transactionId = `remove-${randomUUID()}`;
      await call("prepare-retained-removal", {
        runId: child.runId,
        workspaceId: child.workspaceId,
        transactionId,
      });
      await call("commit-retained-removal", { runId: child.runId, transactionId });
      assert.equal(await lstat(j.childPath).catch((e) => e.code), "ENOENT");
      const shell = inside(state.workspaceRoot, path.join(state.workspaceRoot, child.workspaceId));
      await noLinks(shell);
      await rmdir(shell).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      child.removed = true;
      await save();
    }
    const current = await guard();
    assert.equal(current.status.retainedChildCount, state.baseline.status.retainedChildCount);
    state.cleanupPassed = true;
    await save();
  }
}
process.stdout.write(
  JSON.stringify(
    {
      phase,
      ok: true,
      prepared: state.prepared,
      upgradePassed: state.upgradePassed,
      rebootPassed: state.rebootPassed,
      cleanupPassed: state.cleanupPassed,
      children: state.children.map(({ workspaceId, blockBytes, checks }) => ({
        workspaceId,
        blockBytes,
        checks,
      })),
    },
    null,
    2,
  ) + "\n",
);
