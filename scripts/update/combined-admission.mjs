import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";

/** Refuse legacy source/target clients before service mutation. Marker files must
 * be covered by verifyRelease's authenticated complete payload inventory. */
export async function requireCombinedClients(
  { installationRoot, sourceDirectory, targetDirectory, launcherSha256 },
  verifyRelease,
) {
  assert.equal(typeof verifyRelease, "function", "Authenticated release verifier required");
  const root = path.resolve(installationRoot);
  assert(/^[a-f0-9]{64}$/u.test(launcherSha256));
  const launcher = path.join(root, "HoneyBeeLauncher.exe");
  assert.equal(
    sha256(await readBounded(launcher, 8 * 1024 * 1024)),
    launcherSha256,
    "Launcher changed",
  );
  for (const directory of [sourceDirectory, targetDirectory]) {
    assert.equal(path.dirname(path.resolve(directory)), path.join(root, "versions"));
    assert.equal(
      await verifyRelease(path.resolve(directory)),
      true,
      "Release payload authentication refused",
    );
    assert.deepEqual(
      JSON.parse(await readBounded(path.join(directory, "desktop/combined-client.json"))),
      { schemaVersion: 1, combinedAdmission: 1, isolatedDesktopValidation: 1 },
    );
    assert.deepEqual(
      JSON.parse(await readBounded(path.join(directory, "cli/combined-client.json"))),
      { schemaVersion: 1, combinedAdmission: 1 },
    );
  }
  const result = await promisify(execFile)(launcher, ["--installation-capabilities"], {
    windowsHide: true,
    timeout: 15000,
  });
  const capabilities = JSON.parse(result.stdout);
  assert(
    capabilities.schemaVersion === 1 &&
      capabilities.combinedLaunchGate === 1 &&
      capabilities.combinedRecovery === 1 &&
      capabilities.isolatedDesktopValidation === 1,
    "Setup/bootstrapper upgrade required before service migration",
  );
  return true;
}
