import assert from "node:assert/strict";
import path from "node:path";
import { verifyAppVersion } from "./app-activation.mjs";
import { verifyMatchingStoragePayload } from "./storage-transition.mjs";
import { runDoctorProcess, parseDoctorHealth } from "./version-health.mjs";

// Old CLIs silently ignore --scope. For an app-only transition, the authenticated
// new Doctor can inspect the identical installed storage without treating old
// project bindings as an installation failure. No failed process is normalized.
export function createMatchingStorageDoctor(
  { installationRoot, source, target, authorize },
  { run = runDoctorProcess } = {},
) {
  const root = path.resolve(installationRoot);
  const sourceDirectory = path.join(root, "versions", source.activeVersion);
  const targetDirectory = path.join(root, "versions", target.activeVersion);
  const verify = async () => {
    for (const pointer of [source, target]) {
      await authorize(pointer);
      await verifyAppVersion({
        installationRoot: root,
        version: pointer.activeVersion,
        launchManifestSha256: pointer.manifestSha256,
      });
    }
    await verifyMatchingStoragePayload(sourceDirectory, targetDirectory);
  };
  return async (options) => {
    if (path.resolve(options.cwd) !== sourceDirectory) return run(options);
    assert.equal(path.resolve(options.node), path.join(sourceDirectory, "runtime/node.exe"));
    assert.equal(path.resolve(options.cli), path.join(sourceDirectory, "cli/dist/cli.js"));
    await verify();
    const result = await run({
      ...options,
      cwd: targetDirectory,
      node: path.join(targetDirectory, "runtime/node.exe"),
      cli: path.join(targetDirectory, "cli/dist/cli.js"),
    });
    const { report } = parseDoctorHealth(result.stdout);
    assert.equal(
      report.scope,
      "installation",
      "Replacement Doctor must support installation scope",
    );
    await verify();
    return {
      ...result,
      stdout: JSON.stringify({ ...report, installationDoctorVersion: target.activeVersion }),
    };
  };
}
