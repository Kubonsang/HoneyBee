import assert from "node:assert/strict";
import process from "node:process";
import { createUpdatePlan, revalidateUpdatePlan } from "./update-plan.mjs";
try {
  const [operation, ...args] = process.argv.slice(2);
  let result;
  if (operation === "create") {
    assert.equal(
      args.length,
      5,
      "Usage: plan.mjs create ROOT STAGE MANIFEST_SHA256 BOOTSTRAPPER_VERSION CHANNEL",
    );
    const [installationRoot, stageAttempt, manifestSha256, bootstrapperVersion, channel] = args;
    result = await createUpdatePlan({
      installationRoot,
      stageAttempt,
      manifestSha256,
      bootstrapperVersion,
      channel,
    });
  } else {
    assert(
      operation === "revalidate" && args.length === 3,
      "Usage: plan.mjs revalidate ROOT PLAN_PATH PLAN_SHA256",
    );
    const [installationRoot, planPath, planSha256] = args;
    result = await revalidateUpdatePlan({ installationRoot, planPath, planSha256 });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`Update plan stopped: ${error.message}\n`);
  process.exitCode = 1;
}
