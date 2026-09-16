import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { revalidateUpdatePlan } from "./update-plan.mjs";
import { verifyPublishedVersion } from "./publish-version.mjs";
import { activateAppPointer, recoverAppPointer } from "./app-activation.mjs";

const bind = async (options, hooks) => {
  assert(
    typeof hooks.admit === "function" && typeof hooks.health === "function",
    "Explicit admission and health callbacks required",
  );
  const bytes = await readBounded(options.planPath);
  assert.equal(sha256(bytes), options.planSha256, "Plan SHA-256 mismatch");
  const plan = JSON.parse(bytes);
  assert(
    plan.schemaVersion === 1 &&
      plan.state === "Planned" &&
      plan.activationAllowed === false &&
      plan.identity.status === "app-only-candidate",
    "App-only plan required",
  );
  assert(/^prepare-[A-Za-z0-9]+$/u.test(plan.prepareAttempt), "Invalid plan attempt");
  assert.equal(
    path.resolve(options.planPath),
    path.join(path.resolve(options.installationRoot), "update", plan.prepareAttempt, "plan.json"),
  );
  return {
    installationRoot: options.installationRoot,
    sourcePointerSha256: plan.identity.sourcePointerSha256,
    targetVersion: plan.identity.targetVersion,
    targetManifestSha256: plan.launchManifestSha256,
    transactionDirectory: options.transactionDirectory,
  };
};

/** Internal composition only. Admission must authenticate and hold application quiescence
 * until the returned operation completes; health must validate real component/service state. */
export const activatePublishedUpdate = async (options, hooks = {}) => {
  options = { ...options };
  hooks = { ...hooks };
  const activation = await bind(options, hooks);
  return activateAppPointer(activation, {
    checkpoint: hooks.checkpoint,
    admit: async (context) => {
      assert.equal(await hooks.admit(context), true, "Update admission refused");
      await revalidateUpdatePlan(options, hooks.observe ? { observe: hooks.observe } : undefined);
      await verifyPublishedVersion(options);
    },
    health: async (context) => {
      if (context.phase === "target-before-switch" || context.phase === "target-after-switch")
        await verifyPublishedVersion(options);
      const healthy = await hooks.health(context);
      if (context.phase === "target-before-switch") {
        await revalidateUpdatePlan(options, hooks.observe ? { observe: hooks.observe } : undefined);
        await verifyPublishedVersion(options);
      } else if (context.phase === "target-after-switch") await verifyPublishedVersion(options);
      return healthy;
    },
  });
};

/** Recovery may see either pointer. Do not demand the old live pointer or a healthy
 * target before rollback; the primitive pins both pointers and validates the source. */
export const recoverPublishedUpdate = async (options, hooks = {}) => {
  options = { ...options };
  hooks = { ...hooks };
  const activation = await bind(options, hooks);
  return recoverAppPointer(activation, {
    admit: async (context) => {
      assert.equal(await hooks.admit(context), true, "Recovery admission refused");
    },
    health: async (context) => {
      if (context.phase === "committed-health") await verifyPublishedVersion(options);
      const healthy = await hooks.health(context);
      if (context.phase === "committed-health") await verifyPublishedVersion(options);
      return healthy;
    },
  });
};
