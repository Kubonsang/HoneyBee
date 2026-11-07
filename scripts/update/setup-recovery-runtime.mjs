import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { HoneyBeeWorkspaceCore, readInstalledStorage } from "../../packages/core/dist/index.js";
import { authorizeSetupRuntime } from "./setup-upgrade.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "./recovery-source.mjs";
import { authorizeLegacySetupSource } from "./legacy-setup-source.mjs";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";

export const cleanRecoveryEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        ![
          "NODE_OPTIONS",
          "NODE_PATH",
          "ELECTRON_RUN_AS_NODE",
          "HONEYBEE_WORKSPACE_STORAGE",
        ].includes(key.toUpperCase()),
    ),
  );
export async function inspectSetupRecoverySource(root, trust) {
  const { runtime } = await authorizeSetupRuntime(root);
  const pointerBytes = await readBounded(path.join(root, "current.json"));
  const pointer = JSON.parse(pointerBytes);
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(root, approved);
  const release = path.join(root, "versions", pointer.activeVersion);
  const storageTools = await readInstalledStorage(release);
  assert(storageTools?.managed);
  const report = await new HoneyBeeWorkspaceCore({ storageTools }).doctor({
    scope: "installation",
  });
  const check = (code) => report.checks.find((item) => item.code === code);
  const component = check("storage.component-version")?.actualVersion;
  let legacyVerified = false;
  if (pointer.activeVersion === "0.1.0-beta.35" && component === "0.0.0+cfa606fd4143.hb12") {
    await authorizeLegacySetupSource(root);
    legacyVerified = true;
  }
  const requiredIdentity = [
    "storage.command",
    "storage.control-command",
    "storage.package-integrity",
    "storage.install-receipt",
    "storage.workspace-root",
  ];
  const identityVerified = requiredIdentity.every((code) => check(code)?.status === "pass");
  assert.deepEqual(await readBounded(path.join(root, "current.json")), pointerBytes);
  assert.equal(trust.schemaVersion, 1);
  return {
    installation: "managed",
    currentVersion: pointer.activeVersion,
    bootstrapperVersion: trust.bootstrapperVersion,
    channel: trust.channel,
    storageComponentVersion: component,
    identityVerified,
    legacyVerified,
    pointer,
    pointerSha256: sha256(pointerBytes),
    release,
    helper: path.join(release, "runtime/honeybee-lifecycle.exe"),
    report,
    approved,
  };
}

export async function runRecoveryHelper(helper, args) {
  const result = await promisify(execFile)(helper, args, {
    cwd: path.dirname(helper),
    windowsHide: true,
    env: cleanRecoveryEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

export async function authorizeRecoveryWorker(root, job) {
  const { runtime } = await authorizeSetupRuntime(root);
  const pointerBytes = await readBounded(path.join(job.directory, "source.json"));
  assert.equal(sha256(pointerBytes), job.request.sourcePointerSha256);
  const pointer = JSON.parse(pointerBytes);
  assert.equal(pointer.activeVersion, job.request.sourceVersion);
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(root, approved);
  const release = path.join(root, "versions", pointer.activeVersion);
  for (const file of [
    "runtime/node.exe",
    "runtime/honeybee-lifecycle.exe",
    "desktop/resources/setup/setup-worker.mjs",
  ])
    assert(approved.files[file], "Recovery worker is absent from authenticated source");
  return {
    executable: path.join(release, "runtime/node.exe"),
    worker: path.join(release, "desktop/resources/setup/setup-worker.mjs"),
    helper: path.join(release, "runtime/honeybee-lifecycle.exe"),
  };
}
