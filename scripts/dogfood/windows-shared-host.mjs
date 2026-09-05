// Existing-install functional validation. Never installs/replaces the service or reboots Windows.
import assert from "node:assert/strict";
import console from "node:console";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  digest,
  disjoint,
  inside,
  inventory,
  noLinks,
  preserved,
  rebooted,
  redactUnityLog,
} from "./shared-host-guard.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "run-root": { type: "string" },
    "cli-dir": { type: "string" },
    source: { type: "string" },
    "unity-command": { type: "string" },
    "unity-relative": { type: "string", default: "." },
  },
});
const phase = positionals[0];
assert(
  [
    "run",
    "resume-import",
    "resume-checks",
    "prepare-reboot",
    "resume-reboot",
    "finish-reboot",
  ].includes(phase),
  "Usage: node scripts/dogfood/windows-shared-host.mjs run|prepare-reboot|resume-reboot --run-root <new dedicated directory> [--cli-dir <extracted CLI> --source <Git repo> --unity-command <unity.exe> --unity-relative <subdirectory>]",
);
assert.equal(process.platform, "win32", "This harness requires Windows");
assert(values["run-root"], "--run-root is required");
const root = path.resolve(values["run-root"]);
await noLinks(root);
const statePath = path.join(root, "shared-host-state.json");
let state;

function command(
  executable,
  args,
  { cwd = root, input, allowFailure = false, timeout = 900_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          UNITY_NO_CONSENT_PROMPT: "1",
          UNITY_NO_UPDATE_CHECK: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error && !allowFailure)
          reject(
            new Error(
              `${path.basename(executable)} ${args[0]} failed: ${stderr || stdout || error.message}`,
            ),
          );
        else
          resolve({
            stdout,
            stderr,
            exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const jsonFile = async (target) => JSON.parse(await readFile(target, "utf8"));
const hashFile = async (target) => digest(await readFile(target));
const save = async () => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
const git = async (cwd, args) => (await command("git.exe", ["-C", cwd, ...args])).stdout.trim();
const registryPath = () => path.join(root, "registry", "workspace-registry-v2.json");
const registry = () => jsonFile(registryPath());
async function hb(args, allowFailure = false) {
  const result = await command(
    process.execPath,
    [
      path.join(state.cliDir, "dist", "cli.js"),
      ...args,
      "--data-root",
      path.join(root, "registry"),
      "--json",
    ],
    { allowFailure },
  );
  return { ...result, data: JSON.parse(result.stdout.trim() || result.stderr.trim()) };
}
async function snapshot() {
  const result = await command(
    path.join(state.cliDir, "dist", "honeybee-workspace-storage-host.exe"),
    ["control"],
    {
      input: JSON.stringify({
        schemaVersion: 3,
        operation: "status",
        requestId: `shared-${randomUUID()}`,
      }),
    },
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  return { status: payload.status, inventory: await inventory(state.receiptPath, payload.status) };
}
async function originalRegistryHash() {
  try {
    return await hashFile(state.originalRegistry);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function packageHashes() {
  const result = {};
  for (const name of [
    "cli.js",
    "unity-workspace-storage.exe",
    "honeybee-workspace-storage-host.exe",
  ]) {
    result[name] = await hashFile(path.join(state.cliDir, "dist", name));
  }
  return result;
}
async function guard(allowReboot = false) {
  assert.deepEqual(await packageHashes(), state.packageHashes, "Candidate executables changed");
  assert.equal(
    await originalRegistryHash(),
    state.originalRegistryHash,
    "Original HoneyBee registry changed",
  );
  const records = state.project ? (await registry()).workspaces : [];
  for (const record of records) {
    assert.equal(record.projectId, state.project.projectId);
    assert(
      state.owned.some((item) => item.workspaceId === record.workspaceId),
      "Unrecorded Workspace in test registry",
    );
    inside(path.join(root, "workspaces"), record.workspacePath);
  }
  const current = await snapshot();
  preserved(
    state.baseline.inventory,
    current.inventory,
    records.map((record) => record.leaseId),
    allowReboot,
  );
  return current;
}
async function boot() {
  const windowsBoot = (
    await command("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
    ])
  ).stdout.trim();
  return { windowsBoot, storageBoot: (await snapshot()).status.bootSessionId };
}
async function unity(project, name) {
  inside(root, project);
  const logfile = path.join(root, `${name}.unity.log`);
  const started = new Date().toISOString();
  const result = await command(
    state.unityCommand,
    [
      "run",
      project,
      "--format",
      "json",
      "--timeout",
      "600",
      "--",
      "-nographics",
      "-logFile",
      logfile,
    ],
    { allowFailure: true, timeout: 660_000 },
  );
  await writeFile(
    path.join(root, `${name}.unity-result.json`),
    JSON.stringify({ started, finished: new Date().toISOString(), ...result }, null, 2),
  );
  let log;
  try {
    log = redactUnityLog(await readFile(logfile, "utf8"));
    await writeFile(logfile, log);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.equal(result.exitCode, 0, `Unity failed; inspect ${logfile}`);
  assert(log, "Unity did not produce a verification log");
  assert(
    !/error CS\d+|Scripts have compiler errors|Aborting batchmode due to failure/i.test(log),
    `Unity compilation failed: ${logfile}`,
  );
  return { started, finished: new Date().toISOString(), logfile, exitCode: result.exitCode };
}
async function clean(workspace) {
  inside(root, workspace);
  await noLinks(workspace);
  const status = await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    // Unity may rewrite LF files under a CRLF checkout policy. Refresh only when
    // Git proves the complete normalized tree is identical to HEAD; never stage
    // a real edit or hide an untracked file to make a removal pass.
    assert.equal(await git(workspace, ["ls-files", "--others", "--exclude-standard"]), "");
    await git(workspace, ["diff", "--no-ext-diff", "--no-textconv", "--exit-code", "HEAD", "--"]);
    await git(workspace, ["add", "-u"]);
    await git(workspace, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--exit-code",
      "HEAD",
      "--",
    ]);
    state.noopIndexRefreshes ??= [];
    state.noopIndexRefreshes.push({ workspace, status, at: new Date().toISOString() });
    await save();
  }
  assert.equal(
    await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
    "",
    `Unexpected authored changes in ${workspace}`,
  );
}
async function create(name, attachBranch) {
  await guard();
  const branch = attachBranch ?? `honeybee-shared/${state.runId}/${name}`;
  const response = await hb([
    "workspace",
    attachBranch ? "attach" : "create",
    name,
    "--branch",
    branch,
    "--project",
    state.project.projectId,
  ]);
  const workspace = response.data.workspace;
  assert.equal(workspace.state, "ready");
  inside(path.join(root, "workspaces"), workspace.workspacePath);
  state.owned.push(workspace);
  await save();
  await guard();
  return workspace;
}
async function owned(workspace) {
  const record = (await registry()).workspaces.find(
    (item) => item.workspaceId === workspace.workspaceId,
  );
  assert(
    record && record.projectId === state.project.projectId && record.branch === workspace.branch,
  );
  assert.equal(record.workspacePath, workspace.workspacePath);
  inside(path.join(root, "workspaces"), record.workspacePath);
  return record;
}
async function remove(workspace, allowReboot = false) {
  await guard(allowReboot);
  await owned(workspace);
  await noLinks(workspace.workspacePath);
  await clean(workspace.workspacePath);
  const head = await git(workspace.workspacePath, ["rev-parse", "HEAD"]);
  await hb(["workspace", "remove", workspace.workspaceId, "--project", state.project.projectId]);
  await hb(["workspace", "remove", workspace.workspaceId, "--project", state.project.projectId]);
  assert.equal(
    await git(state.project.repositoryRoot, ["rev-parse", `refs/heads/${workspace.branch}`]),
    head,
  );
  await guard(allowReboot);
  state.removed.push({
    workspaceId: workspace.workspaceId,
    branch: workspace.branch,
    head,
    repeatedRemovePassed: true,
  });
  await save();
}
async function author(workspace) {
  const marker = path.join(workspace.workspacePath, `shared-host-${workspace.name}.txt`);
  await writeFile(marker, `${state.runId}\n${workspace.workspaceId}\n`);
  await git(workspace.workspacePath, ["add", "--", path.basename(marker)]);
  await git(workspace.workspacePath, [
    "-c",
    "user.name=HoneyBee Validation",
    "-c",
    "user.email=validation@localhost",
    "commit",
    "-m",
    `test: isolated ${workspace.name} marker`,
  ]);
  return {
    marker: path.basename(marker),
    hash: await hashFile(marker),
    head: await git(workspace.workspacePath, ["rev-parse", "HEAD"]),
  };
}

async function activeHandleProbe(workspace) {
  await guard();
  await owned(workspace);
  const library = path.join(workspace.workspacePath, state.project.unityRelativePath, "Library");
  inside(path.join(root, "workspaces"), library);
  const target = await readlink(library);
  const file = path.join(library, "shared-host-handle-probe.txt");
  await writeFile(file, `${state.runId}\n`, { flag: "wx" });
  const registryHash = await hashFile(registryPath());
  const branchHead = await git(workspace.workspacePath, ["rev-parse", "HEAD"]);
  const handle = await open(file, "r");
  try {
    const result = await hb(["workspace", "remove", workspace.workspaceId], true);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.data.code, "workspace.in-use");
    assert.equal(await hashFile(registryPath()), registryHash);
    assert.equal(await readlink(library), target);
    assert.equal(await git(workspace.workspacePath, ["rev-parse", "HEAD"]), branchHead);
  } finally {
    await handle.close();
  }
  await guard();
  await unlink(file);
  state.activeHandleRefusalPassed = true;
  await save();
}

async function finishReboot(checkpoint) {
  assert.equal(state.rebootUnity?.exitCode, 0, "A successful post-reboot Unity run is required");
  const runResult = await jsonFile(path.join(root, "reboot-resume.unity-result.json"));
  assert.equal(runResult.exitCode, 0);
  state.observedReboot = await boot();
  rebooted(checkpoint.boot, state.observedReboot);
  await guard(true);
  const workspace = checkpoint.workspace;
  const record = await owned(workspace);
  assert.equal(record.leaseId, checkpoint.lease.leaseId);
  assert.equal(record.storageWorkspaceId, checkpoint.lease.storageWorkspaceId);
  assert.equal(
    (await hb(["workspace", "status", workspace.workspaceId])).data.workspace.state,
    "ready",
  );
  await clean(workspace.workspacePath);
  assert.equal(await git(workspace.workspacePath, ["rev-parse", "HEAD"]), checkpoint.authored.head);
  assert.equal(
    await hashFile(path.join(workspace.workspacePath, checkpoint.authored.marker)),
    checkpoint.authored.hash,
  );
  const library = path.join(workspace.workspacePath, state.project.unityRelativePath, "Library");
  assert.equal(await readlink(library), checkpoint.libraryTarget);
  assert.equal(
    await hashFile(path.join(library, "shared-host-reboot-marker.txt")),
    checkpoint.libraryMarkerHash,
  );
  await save();
  await remove(workspace, true);
  state.reboot = "passed";
  state.phase = "existing-install-validation-passed";
  state.afterReboot = await guard(true);
  await save();
  console.log(
    `Physical reboot/repair passed. Fresh install and Beta 3 upgrade remain unverified. Evidence: ${statePath}`,
  );
}

try {
  if (["run", "resume-import", "resume-checks"].includes(phase)) {
    let source;
    let workspaces;
    if (phase === "resume-checks") {
      state = await jsonFile(statePath);
      assert.equal(state.root, root);
      assert.equal(state.phase, "functional-running");
      assert.equal(state.owned.length, 4);
      assert.equal(state.removed.length, 0);
      assert.equal(state.repairPassed, true);
      workspaces = state.owned;
      for (const workspace of workspaces) {
        assert.equal(state.unity[workspace.name].exitCode, 0);
        assert(state.commits[workspace.workspaceId].head);
      }
      source = state.source;
      await guard();
    } else {
      const clone = path.join(root, "source");
      let unityProject;
      if (phase === "run") {
        assert(
          values.source && values["cli-dir"] && values["unity-command"],
          "run requires --source, --cli-dir and --unity-command",
        );
        source = path.resolve(values.source);
        disjoint(source, root);
        // Exclusive creation prevents reusing a previous run or taking over user data.
        await mkdir(root);
        state = {
          schemaVersion: 1,
          runId: randomUUID(),
          root,
          phase: "preflight",
          source,
          cliDir: path.resolve(values["cli-dir"]),
          unityCommand: path.resolve(values["unity-command"]),
          unityRelative: values["unity-relative"],
          receiptPath: path.join(
            process.env.ProgramData,
            "UnityWorkspaceStorage",
            "install-receipt.json",
          ),
          originalRegistry: path.join(
            process.env.LOCALAPPDATA,
            "HoneyBee",
            "workspace-core",
            "workspace-registry-v2.json",
          ),
          owned: [],
          removed: [],
          scope: "existing-install-shared-host",
          freshInstall: "unverified",
          beta3Upgrade: "unverified",
          interactiveEditors: "unverified",
          externalAgentRuns: "unverified",
          reboot: "pending",
        };
        await save();
        state.packageHashes = await packageHashes();
        state.version = (
          await command(process.execPath, [path.join(state.cliDir, "dist", "cli.js"), "--version"])
        ).stdout.trim();
        state.originalRegistryHash = await originalRegistryHash();
        const doctor = await hb(["doctor"]);
        assert.equal(doctor.data.ready, true, "Resolve Doctor blockers before proceeding");
        state.baseline = await snapshot();
        state.sourceHead = await git(source, ["rev-parse", "HEAD"]);
        state.sourceStatusHash = digest(
          await git(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
        );
        await save();
        await guard();
        console.log("Cloning committed source into the dedicated run directory...");
        await command("git.exe", [
          "clone",
          "--no-checkout",
          "--no-hardlinks",
          "--local",
          "--single-branch",
          source,
          clone,
        ]);
        // Keep Git clone protection enabled; perform LFS checkout separately without hooks.
        await git(clone, ["-c", "core.hooksPath=NUL", "checkout", "--force", "HEAD"]);
        await git(clone, ["remote", "remove", "origin"]);
        assert.equal(await git(clone, ["rev-parse", "HEAD"]), state.sourceHead);
        unityProject = path.resolve(clone, state.unityRelative);
        if (unityProject !== clone) inside(clone, unityProject);
        for (const dir of ["Assets", "Packages", "ProjectSettings"])
          assert((await lstat(path.join(unityProject, dir))).isDirectory());
        assert.equal(
          await git(clone, ["ls-files", "--", path.join(state.unityRelative, "Library")]),
          "",
          "Library must not be tracked",
        );
        console.log("Importing the disposable source with Unity...");
        state.sourceUnity = await unity(unityProject, "source");
        await clean(clone);
      } else {
        state = await jsonFile(statePath);
        assert.equal(state.root, root);
        assert.equal(state.phase, "preflight");
        assert.equal(state.owned.length, 0);
        assert(!state.project, "Import resume cannot re-run Workspace creation");
        assert.equal(
          state.sourceUnity.exitCode,
          0,
          "Only a successful imported clone can be resumed",
        );
        await guard();
        source = state.source;
        unityProject = path.resolve(clone, state.unityRelative);
        if (unityProject !== clone) inside(clone, unityProject);
        await clean(clone);
        await git(clone, ["merge-base", "--is-ancestor", state.sourceHead, "HEAD"]);
      }
      state.importedSeedHead = await git(clone, ["rev-parse", "HEAD"]);
      state.phase = "functional-running";
      await save();
      state.project = (
        await hb([
          "project",
          "init",
          unityProject,
          "--workspace-root",
          path.join(root, "workspaces"),
        ])
      ).data.project;
      await save();
      await guard();
      console.log("Preparing Library cache and four isolated Workspaces...");
      await hb(["cache", "prepare", "--project", state.project.projectId]);
      await guard();
      workspaces = [];
      for (const name of ["combat", "ui", "enemy-ai", "level"]) workspaces.push(await create(name));
      const targets = new Set();
      for (const workspace of workspaces) {
        assert((await lstat(path.join(workspace.workspacePath, ".git"))).isFile());
        const library = path.join(
          workspace.workspacePath,
          state.project.unityRelativePath,
          "Library",
        );
        const target = await readlink(library);
        assert(!targets.has(target), "Library target shared by multiple Workspaces");
        targets.add(target);
      }
      // Repair only a recorded test Workspace's junction, never traverse its Library target.
      await guard();
      await owned(workspaces[1]);
      const repairLibrary = path.join(
        workspaces[1].workspacePath,
        state.project.unityRelativePath,
        "Library",
      );
      inside(path.join(root, "workspaces"), repairLibrary);
      assert((await lstat(repairLibrary)).isSymbolicLink());
      await unlink(repairLibrary);
      assert.equal(
        (await hb(["workspace", "status", workspaces[1].workspaceId])).data.workspace.state,
        "repair-required",
      );
      assert.equal(
        (await hb(["workspace", "repair", workspaces[1].workspaceId])).data.workspace.state,
        "ready",
      );
      state.repairPassed = true;
      state.commits = {};
      for (const workspace of workspaces)
        state.commits[workspace.workspaceId] = await author(workspace);
      console.log("Running two concurrent batch Editors, then the remaining Workspaces...");
      state.unity = {};
      for (let index = 0; index < workspaces.length; index += 2) {
        const pair = workspaces.slice(index, index + 2);
        const results = await Promise.allSettled(
          pair.map((workspace) =>
            unity(
              path.join(workspace.workspacePath, state.project.unityRelativePath),
              workspace.name,
            ),
          ),
        );
        results.forEach((result, offset) => {
          if (result.status === "fulfilled") state.unity[pair[offset].name] = result.value;
        });
        await save();
        for (const result of results) if (result.status === "rejected") throw result.reason;
        await guard();
      }
    }
    for (const workspace of workspaces) {
      await clean(workspace.workspacePath);
      assert.equal(
        await git(workspace.workspacePath, ["rev-parse", "HEAD"]),
        state.commits[workspace.workspaceId].head,
      );
      for (const other of workspaces.filter((item) => item !== workspace)) {
        assert.equal(
          await git(workspace.workspacePath, ["ls-files", "--", `shared-host-${other.name}.txt`]),
          "",
          "Authored marker leaked across branches",
        );
      }
    }
    state.afterUnity = await guard();
    const probe = workspaces[0];
    const dirtyPath = path.join(probe.workspacePath, ".shared-host-dirty-probe");
    await writeFile(dirtyPath, "owned dirty probe\n", { flag: "wx" });
    const registryHash = await hashFile(registryPath());
    const refused = await hb(["workspace", "remove", probe.workspaceId], true);
    assert.notEqual(refused.exitCode, 0);
    assert.equal(refused.data.code, "workspace.dirty");
    assert.equal(await hashFile(registryPath()), registryHash);
    await unlink(dirtyPath);
    state.dirtyRefusalPassed = true;
    await save();
    for (const workspace of workspaces) await remove(workspace);
    const attached = await create("attach-probe", workspaces[0].branch);
    await remove(attached);
    state.final = await guard();
    assert.equal(await git(source, ["rev-parse", "HEAD"]), state.sourceHead);
    assert.equal(
      digest(await git(source, ["status", "--porcelain=v1", "--untracked-files=all"])),
      state.sourceStatusHash,
    );
    assert.equal((await hb(["doctor"])).data.ready, true);
    state.phase = "functional-passed";
    await save();
    console.log(`Shared-host functional checks passed. Evidence: ${statePath}`);
  } else {
    state = await jsonFile(statePath);
    assert.equal(state.root, root);
    assert.equal(state.schemaVersion, 1);
    if (phase === "prepare-reboot") {
      assert.equal(state.phase, "functional-passed");
      await guard();
      const workspace = await create("reboot-probe");
      await activeHandleProbe(workspace);
      const authored = await author(workspace);
      const library = path.join(
        workspace.workspacePath,
        state.project.unityRelativePath,
        "Library",
      );
      const libraryMarker = path.join(library, "shared-host-reboot-marker.txt");
      await writeFile(libraryMarker, `${state.runId}\n${workspace.workspaceId}\n`, { flag: "wx" });
      state.rebootCheckpoint = {
        workspace,
        authored,
        libraryMarkerHash: await hashFile(libraryMarker),
        libraryTarget: await readlink(library),
        boot: await boot(),
        lease: await owned(workspace),
        registryHash: await hashFile(registryPath()),
      };
      state.phase = "awaiting-reboot";
      await save();
      console.log(
        `Checkpoint saved. Reboot normally when convenient, then run resume-reboot --run-root "${root}". No reboot was requested.`,
      );
    } else if (phase === "finish-reboot") {
      assert.equal(state.phase, "awaiting-reboot");
      await finishReboot(state.rebootCheckpoint);
    } else {
      assert.equal(state.phase, "awaiting-reboot");
      const checkpoint = state.rebootCheckpoint;
      rebooted(checkpoint.boot, await boot());
      await guard(true);
      assert.equal(await hashFile(registryPath()), checkpoint.registryHash);
      const workspace = checkpoint.workspace;
      assert.deepEqual(await owned(workspace), checkpoint.lease);
      await clean(workspace.workspacePath);
      assert.equal(
        await git(workspace.workspacePath, ["rev-parse", "HEAD"]),
        checkpoint.authored.head,
      );
      assert.equal(
        await hashFile(path.join(workspace.workspacePath, checkpoint.authored.marker)),
        checkpoint.authored.hash,
      );
      assert.equal(
        (await hb(["workspace", "status", workspace.workspaceId])).data.workspace.state,
        "repair-required",
      );
      assert.equal(
        (await hb(["workspace", "repair", workspace.workspaceId])).data.workspace.state,
        "ready",
      );
      const repaired = await owned(workspace);
      assert.equal(repaired.leaseId, checkpoint.lease.leaseId);
      assert.equal(repaired.storageWorkspaceId, checkpoint.lease.storageWorkspaceId);
      const library = path.join(
        workspace.workspacePath,
        state.project.unityRelativePath,
        "Library",
      );
      assert.equal(await readlink(library), checkpoint.libraryTarget);
      assert.equal(
        await hashFile(path.join(library, "shared-host-reboot-marker.txt")),
        checkpoint.libraryMarkerHash,
      );
      state.rebootUnity = await unity(
        path.join(workspace.workspacePath, state.project.unityRelativePath),
        "reboot-resume",
      );
      await save();
      assert.equal(
        await hashFile(path.join(workspace.workspacePath, checkpoint.authored.marker)),
        checkpoint.authored.hash,
      );
      await finishReboot(checkpoint);
    }
  }
} catch (error) {
  if (state) {
    state.lastError = { phase, message: error.message, at: new Date().toISOString() };
    await save();
  }
  console.error(
    `${error.message}\nStopped without automatic cleanup. Preserve the run directory and inspect ${statePath}.`,
  );
  process.exitCode = 1;
}
