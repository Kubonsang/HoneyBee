import assert from "node:assert/strict";
import process from "node:process";
import { prepareRelease } from "./prepare-release.mjs";
try {
  const [
    installationRoot,
    stageAttempt,
    manifestSha256,
    currentVersion,
    bootstrapperVersion,
    channel,
    storageComponentVersion,
    ...extra
  ] = process.argv.slice(2);
  assert(
    storageComponentVersion && !extra.length,
    "Usage: prepare.mjs INSTALL_ROOT STAGE_ATTEMPT MANIFEST_SHA256 CURRENT_VERSION BOOTSTRAPPER_VERSION CHANNEL STORAGE_VERSION",
  );
  process.stdout.write(
    JSON.stringify(
      await prepareRelease({
        installationRoot,
        stageAttempt,
        manifestSha256,
        source: { currentVersion, bootstrapperVersion, channel, storageComponentVersion },
      }),
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}
