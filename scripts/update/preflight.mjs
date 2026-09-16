import assert from "node:assert/strict";
import process from "node:process";
import { observeUpdateSource } from "./observe-source.mjs";
try {
  const [installationRoot, manifestPath, manifestSha256, bootstrapperVersion, channel, ...extra] =
    process.argv.slice(2);
  assert(
    channel && !extra.length,
    "Usage: preflight.mjs INSTALL_ROOT MANIFEST SHA256 BOOTSTRAPPER_VERSION CHANNEL",
  );
  const plan = await observeUpdateSource({
    installationRoot,
    manifestPath,
    manifestSha256,
    bootstrapperVersion,
    channel,
  });
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  process.exitCode = plan.status === "app-only-candidate" ? 0 : 2;
} catch (error) {
  process.stderr.write(`Update preflight stopped: ${error.message}\n`);
  process.exitCode = 1;
}
