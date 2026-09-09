// Normal-user installed-service qualification. Never restarts SCM or Windows.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digest, healthy, inside, inventory, noLinks } from "./shared-host-guard.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [phase, argument, legacyParent] = process.argv.slice(2);
const compressionUpgrade = process.env.HONEYBEE_BEE_COMPRESSION_UPGRADE === "1";
assert(["prepare", "upgrade-check", "restart-check", "resume-reboot", "cleanup"].includes(phase));
assert(argument && path.isAbsolute(argument));
const root = inside(path.join(repo, "output"), path.resolve(argument));
await noLinks(root);
const statePath = path.join(root, "state.json");
const tools = path.join(
  repo,
  compressionUpgrade
    ? "apps/desktop/release-bee-compressed-preview/HoneyBee-win32-x64/resources/win32-x64"
    : "apps/desktop/release-bee-preview/HoneyBee-win32-x64/resources/win32-x64",
);
const host = path.join(tools, "honeybee-workspace-storage-host.exe");
const client = path.join(tools, "unity-workspace-storage.exe");
const receiptPath = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/install-receipt.json",
);
const registryPath = path.join(
  process.env.LOCALAPPDATA,
  "HoneyBee/workspace-core/workspace-registry-v2.json",
);
const oldVersion = compressionUpgrade ? "0.0.0+cfa606fd4143.hb11" : "0.0.0+c238f283ded2.hb10";
const newVersion = compressionUpgrade ? "0.0.0+cfa606fd4143.hb12" : "0.0.0+cfa606fd4143.hb11";
const newHostHash = compressionUpgrade
  ? "0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3"
  : "9b790d02c399d1b47aa94cab1863dfe092fb3a89775714b00f01ccc3ca6141aa";
const layout = "external-bee-dag-v1";
const json = async (p) => JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/u, ""));
const exists = async (p) =>
  (await lstat(p).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  })) !== undefined;
async function hashFile(p) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk);
  return h.digest("hex");
}
function run(exe, args, input, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      {
        cwd: repo,
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 8 << 20,
        env: { ...process.env, ...environment },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${path.basename(exe)}: ${stdout || stderr || error.message}`));
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
async function call(operation, fields = {}) {
  const v = JSON.parse(
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
  assert.equal(v.ok, true, JSON.stringify(v.error));
  return v;
}
const boot = async () =>
  (
    await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
    ])
  ).trim();
let state;
const save = async () => writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
async function installed(version) {
  const r = await json(receiptPath);
  assert.equal(r.componentVersion, version);
  assert.equal(await hashFile(r.executable), r.executableSha256);
  if (version === newVersion) assert.equal(r.executableSha256, newHostHash);
  return r;
}
async function guard() {
  assert.equal(await hashFile(registryPath), state.registryHash, "User registry changed");
  const status = (await call("status")).status;
  healthy(status);
  const expected = state.baseline.children.map((c) => `${c.leaseId}.vhdx`);
  for (const child of state.children.filter((c) => !c.removed)) {
    expected.push(`${child.leaseId}.vhdx`);
    if (child.external) expected.push(`${child.leaseId}.bee`);
  }
  assert.deepEqual((await readdir(path.join(state.userRoot, "children"))).sort(), expected.sort());
  assert.equal(
    status.retainedChildCount,
    state.baseline.children.length + state.children.filter((c) => !c.removed).length,
  );
  for (const c of state.baseline.children) {
    assert.equal(await hashFile(c.childPath), c.sha256, "Original user VHDX changed");
    assert.equal(
      await hashFile(path.join(state.userRoot, "leases", `${c.leaseId}.json`)),
      c.leaseHash,
    );
    assert.equal(
      await hashFile(path.join(state.userRoot, "retained", `${c.runId}.json`)),
      c.retainedHash,
    );
  }
  return status;
}
async function journal(c) {
  const j = await json(path.join(state.userRoot, "leases", `${c.leaseId}.json`));
  assert.equal(j.runId, c.runId);
  assert.equal(j.workspaceId, c.workspaceId);
  assert.equal(
    path.resolve(j.childPath),
    path.join(state.userRoot, "children", `${c.leaseId}.vhdx`),
  );
  assert.equal(path.resolve(j.mountPath), path.join(state.workspaceRoot, c.workspaceId, "Library"));
  assert.equal(j.parentKey, c.parentKey.digest);
  assert.equal(j.layout, c.external ? layout : undefined);
  return j;
}
async function checkMounted(c, lease) {
  const j = await journal(c);
  assert.equal(lease.leaseId, c.leaseId);
  assert.deepEqual(j.fileIdentity, c.fileIdentity);
  assert.equal(
    await readFile(path.join(j.mountPath, "honeybee-installed-bee.txt"), "utf8"),
    c.marker,
  );
  const target = (await run("mountvol.exe", [j.mountPath, "/L"])).trim().replace(/\\+$/u, "");
  assert.equal(target.toLowerCase(), j.volumeGuid.replace(/\\+$/u, "").toLowerCase());
  if (c.external) {
    const cache = j.childPath.replace(/\.vhdx$/u, ".bee");
    assert.equal(
      path.resolve(await readlink(path.join(j.mountPath, "Bee"))),
      path.join(cache, "data"),
    );
    assert.equal(await readFile(path.join(j.mountPath, "Bee/private.txt"), "utf8"), c.marker);
    assert.equal(
      await readFile(path.join(j.mountPath, "Bee/TundraBuildState.state"), "utf8"),
      "retain-state",
    );
    assert.equal(await exists(path.join(j.mountPath, "Bee/test.dag")), false);
    const owner = path.join(cache, "owner.json");
    assert.equal(await hashFile(owner), c.ownerHash);
    if (c.compressed) {
      for (const relative of ["data", "data/cache.bin", "data/private.txt"]) {
        const compressed = JSON.parse(
          await run(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              "[bool]((Get-Item -LiteralPath $env:HB_COMPRESSION_CHECK -Force).Attributes -band [IO.FileAttributes]::Compressed) | ConvertTo-Json",
            ],
            undefined,
            { HB_COMPRESSION_CHECK: path.join(cache, relative) },
          ),
        );
        assert.equal(compressed, true, "New private Bee compression/inheritance was lost");
      }
    }
  }
  await call("heartbeat", { leaseId: c.leaseId });
}
async function create(parentKey, external) {
  const id = `hb-bee-upgrade-${randomUUID()}`;
  const shell = inside(state.workspaceRoot, path.join(state.workspaceRoot, id));
  await noLinks(shell);
  state.pendingWorkspace = shell;
  await save();
  await mkdir(shell);
  const response = await call("acquire", { workspaceId: id, runId: id, parentKey });
  const c = {
    workspaceId: id,
    runId: id,
    leaseId: response.lease.leaseId,
    parentKey,
    external,
    compressed: compressionUpgrade && external,
    marker: randomUUID() + "\n",
    checks: [],
  };
  state.children.push(c);
  delete state.pendingWorkspace;
  await save();
  try {
    const j = await journal(c);
    c.fileIdentity = j.fileIdentity;
    await writeFile(path.join(j.mountPath, "honeybee-installed-bee.txt"), c.marker, { flag: "wx" });
    if (external) {
      assert.equal(await readFile(path.join(j.mountPath, "Bee/cache.bin"), "utf8"), "warm-cache");
      await writeFile(path.join(j.mountPath, "Bee/private.txt"), c.marker, { flag: "wx" });
      const owner = path.join(j.childPath.replace(/\.vhdx$/u, ".bee"), "owner.json");
      const bytes = await readFile(owner);
      await assert.rejects(writeFile(owner, bytes), (e) => ["EACCES", "EPERM"].includes(e.code));
      c.ownerHash = digest(bytes);
    }
    await checkMounted(c, response.lease);
  } finally {
    await call("release", { leaseId: c.leaseId, retainChild: true });
    await save();
  }
  c.checks.push("created-retained");
  await save();
}
async function cycle(c, label) {
  const v = await call("attach-retained", { workspaceId: c.workspaceId, runId: c.runId });
  try {
    await checkMounted(c, v.lease);
  } finally {
    await call("release", { leaseId: c.leaseId, retainChild: true });
  }
  c.checks.push(label);
  await save();
}
async function measureUsage() {
  const children = state.children.filter((c) => !c.removed);
  const report = JSON.parse(
    await run(
      path.join(tools, "honeybee-usage.exe"),
      [],
      JSON.stringify({
        schemaVersion: 1,
        workspaces: children.map((c) => ({
          workspaceId: c.workspaceId,
          workspacePath: path.join(state.workspaceRoot, c.workspaceId),
          unityRelativePath: ".",
          leaseId: c.leaseId,
          parentId: c.parentKey.digest,
          storageWorkspaceId: c.workspaceId,
          consumerId: c.runId,
        })),
        cacheRoots: [],
      }),
    ),
  );
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.equal(
    report.entries.filter((e) => e.kind === "external-bee").length,
    children.filter((c) => c.external).length,
  );
  assert.equal(report.entries.filter((e) => e.kind === "bee-seed").length, 1);
  for (const e of report.entries.filter((e) => ["external-bee", "bee-seed"].includes(e.kind))) {
    assert(e.logicalBytes > 0 && e.allocatedBytes >= 0 && e.complete);
  }
  await writeFile(path.join(root, `${phase}-usage.json`), JSON.stringify(report, null, 2) + "\n");
}
async function remove(c) {
  const j = await journal(c);
  const transactionId = `remove-${randomUUID()}`;
  await call("prepare-retained-removal", {
    runId: c.runId,
    workspaceId: c.workspaceId,
    transactionId,
  });
  await call("abort-retained-removal", { runId: c.runId, transactionId });
  // Abort preserves the attached session created by prepare; release it before reattaching.
  await checkMounted(c, { leaseId: c.leaseId });
  await call("release", { leaseId: c.leaseId, retainChild: true });
  await cycle(c, "removal-abort");
  const committed = `remove-${randomUUID()}`;
  await call("prepare-retained-removal", {
    runId: c.runId,
    workspaceId: c.workspaceId,
    transactionId: committed,
  });
  await call("commit-retained-removal", { runId: c.runId, transactionId: committed });
  assert.equal(await exists(j.childPath), false);
  if (c.external) assert.equal(await exists(j.childPath.replace(/\.vhdx$/u, ".bee")), false);
  const shell = inside(state.workspaceRoot, path.join(state.workspaceRoot, c.workspaceId));
  await noLinks(shell);
  await rmdir(shell).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  c.removed = true;
  await save();
}

if (phase === "prepare") {
  assert(/^[a-f0-9]{64}$/u.test(legacyParent));
  const receipt = await installed(oldVersion);
  const status = (await call("status")).status;
  const baseline = await inventory(receiptPath, status);
  for (const c of baseline.children) c.sha256 = await hashFile(c.childPath);
  await mkdir(root);
  const userRoot = inside(receipt.storeRoot, path.join(receipt.storeRoot, receipt.userSid));
  const parent = await json(path.join(userRoot, "parents", legacyParent, "metadata.json"));
  assert.equal(parent.compatibilityKey.digest, legacyParent);
  assert.equal(parent.compatibilityKey.layout, undefined);
  state = {
    schemaVersion: 1,
    compressionUpgrade,
    baseline,
    registryHash: await hashFile(registryPath),
    userRoot,
    workspaceRoot: path.resolve(receipt.workspaceRoot),
    children: [],
    windowsBoot: await boot(),
  };
  await save();
  await create(parent.compatibilityKey, false);
  await guard();
  state.prepared = true;
} else {
  state = await json(statePath);
  assert.equal(state.compressionUpgrade ?? false, compressionUpgrade, "Upgrade profile mismatch");
  assert(state.prepared);
  await installed(newVersion);
  await guard();
  if (phase === "upgrade-check") {
    assert(!state.upgradePassed && state.children.length === 1);
    const hello = await call("hello");
    assert(hello.parentLayouts.includes(layout));
    await cycle(state.children[0], compressionUpgrade ? "hb11-to-hb12" : "hb10-to-hb11");
    state.externalKey = digest(Buffer.from(`HoneyBee installed Bee fixture ${randomUUID()}`));
    await save();
    const begin = JSON.parse(
      await run(client, [
        "parent",
        "begin",
        "--compatibility-key",
        state.externalKey,
        "--layout",
        layout,
        "--request-id",
        randomUUID(),
      ]),
    );
    assert.equal(begin.ok, true);
    assert(begin.transactionId && begin.stagingPath);
    state.parentTransaction = begin.transactionId;
    state.parentStaging = begin.stagingPath;
    await save();
    await mkdir(path.join(begin.stagingPath, "Bee"));
    for (const [name, value] of Object.entries({
      "Bee/cache.bin": "warm-cache",
      "Bee/TundraBuildState.state": "retain-state",
      "Bee/test.dag": "omit-graph",
      LibraryVersion: "installed-fixture",
    }))
      await writeFile(path.join(begin.stagingPath, name), value, { flag: "wx" });
    const commit = JSON.parse(
      await run(client, [
        "parent",
        "commit",
        "--transaction-id",
        begin.transactionId,
        "--request-id",
        randomUUID(),
      ]),
    );
    assert.equal(commit.ok, true);
    const parent = await json(
      path.join(state.userRoot, "parents", state.externalKey, "metadata.json"),
    );
    assert.equal(parent.compatibilityKey.layout, layout);
    assert(parent.beeSeed.sha256 && parent.beeSeed.logicalBytes > 0);
    state.parentCommitted = true;
    await save();
    await create(parent.compatibilityKey, true);
    await create(parent.compatibilityKey, true);
    for (const c of state.children) await cycle(c, "post-upgrade");
    await measureUsage();
    state.postUpgradeStatus = await guard();
    state.upgradePassed = true;
  } else if (phase === "restart-check") {
    assert(state.upgradePassed && !state.restartPassed);
    const restart = await json(
      path.join(
        repo,
        compressionUpgrade
          ? "output/bee-compression-scm-restart.json"
          : "output/external-bee-scm-restart.json",
      ),
    );
    assert(
      restart.ok && restart.beforePid !== restart.afterPid,
      "Recorded SCM restart is required",
    );
    assert.equal(Date.parse(restart.windowsBoot), Date.parse(state.windowsBoot));
    assert.equal(
      Date.parse(await boot()),
      Date.parse(state.windowsBoot),
      "This phase requires SCM restart without Windows reboot",
    );
    for (const c of state.children.filter((c) => !c.removed)) await cycle(c, "scm-restart");
    if (!state.children[1].removed) await remove(state.children[1]);
    await cycle(state.children[2], "surviving-child");
    await measureUsage();
    state.preRebootStatus = await guard();
    state.preRebootWindowsBoot = await boot();
    state.restartPassed = true;
  } else if (phase === "resume-reboot") {
    assert(state.restartPassed && !state.rebootPassed);
    assert.notEqual(
      Date.parse(await boot()),
      Date.parse(state.preRebootWindowsBoot),
      "Physical Windows reboot is still required",
    );
    const status = (await call("status")).status;
    assert.notEqual(status.bootSessionId, state.preRebootStatus.bootSessionId);
    for (const c of state.children.filter((c) => !c.removed)) await cycle(c, "physical-reboot");
    state.postRebootStatus = await guard();
    state.rebootPassed = true;
  } else {
    assert(state.rebootPassed, "Preserve fixtures until physical reboot validation");
    for (const c of state.children.filter((c) => !c.removed)) await remove(c);
    state.finalStatus = await guard();
    state.cleanupPassed = true;
  }
}
await save();
const result = {
  phase,
  ok: true,
  prepared: state.prepared,
  upgradePassed: state.upgradePassed,
  restartPassed: state.restartPassed,
  rebootPassed: state.rebootPassed,
  cleanupPassed: state.cleanupPassed,
  originalChildrenPreserved: state.baseline.children.length,
  children: state.children.map(({ external, removed, checks }) => ({
    external,
    removed: removed ?? false,
    checks,
  })),
};
await writeFile(path.join(root, `${phase}-result.json`), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
