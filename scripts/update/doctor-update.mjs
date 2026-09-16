import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { checkVersionHealth } from "./version-health.mjs";
import { activatePublishedUpdate, recoverPublishedUpdate } from "./published-update.mjs";

const execute = async (recover, options, hooks) => {
  options = { ...options };
  hooks = { ...hooks };
  assert(
    typeof hooks.admit === "function" && typeof hooks.authorizeHealth === "function",
    "Explicit update admission and Doctor authorization required",
  );
  const root = path.resolve(options.installationRoot);
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
  let sourcePath = path.join(root, "current.json");
  if (recover) {
    const transaction = path.resolve(options.transactionDirectory);
    assert(
      path.dirname(transaction) === path.join(root, "update/activations") &&
        /^activation-[A-Za-z0-9]+$/u.test(path.basename(transaction)),
      "Recovery outside installation",
    );
    await plainDirectory(transaction);
    sourcePath = path.join(transaction, "source.json");
  }
  const sourceBytes = await readBounded(sourcePath);
  assert.equal(
    sha256(sourceBytes),
    plan.identity.sourcePointerSha256,
    "Source pointer pin mismatch",
  );
  const source = JSON.parse(sourceBytes);
  assert.equal(source.activeVersion, plan.identity.sourceVersion, "Source version mismatch");
  const versions = {
    source: { version: source.activeVersion, launchManifestSha256: source.manifestSha256 },
    target: {
      version: plan.identity.targetVersion,
      launchManifestSha256: plan.launchManifestSha256,
    },
  };
  const phases = {
    "source-health": "source",
    "target-before-switch": "target",
    "target-after-switch": "target",
    rollback: "source",
    "committed-health": "target",
    "rolled-back-health": "source",
  };
  const healthChecks = [];
  const health = async (context) => {
    assert.equal(path.resolve(context.root), root, "Health root mismatch");
    assert(Object.hasOwn(phases, context.phase), "Unknown health phase");
    const selected = versions[phases[context.phase]];
    assert.equal(context.version, selected.version, "Health version mismatch");
    const result = await checkVersionHealth(
      { installationRoot: root, ...selected, timeoutMs: options.healthTimeoutMs },
      {
        authorize: (identity) =>
          hooks.authorizeHealth(Object.freeze({ ...identity, phase: context.phase })),
        ...(hooks.runDoctor ? { run: hooks.runDoctor } : {}),
      },
    );
    healthChecks.push({ phase: context.phase, ...result });
    return result.ready === true;
  };
  try {
    const operation = recover ? recoverPublishedUpdate : activatePublishedUpdate;
    return { ...(await operation(options, { ...hooks, health })), healthChecks };
  } catch (error) {
    // Keep failed Doctor evidence available to the caller even when recovery is required.
    throw Object.assign(new Error(error.message, { cause: error }), { healthChecks });
  }
};

/** Internal only: admission must establish release trust, source evidence and sustained
 * application quiescence. Doctor authorization must validate the selected full payload.
 * Doctor does not establish Desktop UI readiness or authorize service migration. */
export const activatePublishedUpdateWithDoctor = (options, hooks = {}) =>
  execute(false, options, hooks);
export const recoverPublishedUpdateWithDoctor = (options, hooks = {}) =>
  execute(true, options, hooks);
