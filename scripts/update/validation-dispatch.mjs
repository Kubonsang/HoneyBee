import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { sha256, compareVersions } from "./release-manifest.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { createValidationDesktopTransport } from "./desktop-session.mjs";

/** User-level candidate launch. The authorizer must bind the exact protected
 * service transaction; payload verification must authenticate all release files.
 * Replays use the candidate's deterministic validation profile/single-instance lock. */
export function createInstalledValidationDesktop(options, hooks) {
  const root = path.resolve(options.installationRoot);
  const version = options.version;
  compareVersions(version, "0.0.0");
  assert.equal(path.basename(version), version);
  for (const name of ["launcherSha256", "targetPointerSha256", "validationId"])
    assert(/^[a-f0-9]{64}$/u.test(options[name]), `Invalid ${name}`);
  for (const name of ["authorize", "verifyRelease"])
    assert.equal(typeof hooks[name], "function", `Validation ${name} required`);
  const authorize = async (identity) => {
    assert.equal(await hooks.authorize(identity), true, "Protected candidate admission refused");
    await plainDirectory(root);
    const pointerBytes = await readBounded(path.join(root, "current.json"));
    assert.equal(sha256(pointerBytes), options.targetPointerSha256, "Selected pointer changed");
    const pointer = JSON.parse(pointerBytes);
    assert.equal(pointer.schemaVersion, 1);
    assert.equal(pointer.activeVersion, version);
    const release = path.join(root, "versions", version);
    await plainDirectory(release);
    assert.equal(
      await hooks.verifyRelease(release),
      true,
      "Candidate payload authentication refused",
    );
    assert.equal(
      sha256(await readBounded(path.join(root, "HoneyBeeLauncher.exe"), 8 * 1024 * 1024)),
      options.launcherSha256,
      "Launcher changed",
    );
    return true;
  };
  return createValidationDesktopTransport(options, {
    authorize,
    launchCandidate: async (identity) => {
      await authorize(identity);
      const child = spawn(path.join(root, "HoneyBeeLauncher.exe"), identity.arguments, {
        cwd: root,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.unref();
      // Spawn is dispatch only. The transport still requires authenticated
      // renderer readiness; it never treats process creation as validation.
    },
  });
}
