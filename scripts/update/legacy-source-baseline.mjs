import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { validateCombinedApplicationContext } from "./combined-application.mjs";
import { observeUpdateSource } from "./observe-source.mjs";

/** Verify restoration of the known, already incompatible source. This is never
 * a successful Doctor result and cannot authorize target activation. Callers
 * must authenticate both releases before executing their inspection helpers. */
export async function checkLegacySourceBaseline(
  { installationRoot, context },
  { authorize, observe = observeUpdateSource } = {},
) {
  assert.equal(typeof authorize, "function", "Explicit baseline inspection authorization required");
  const root = path.resolve(installationRoot);
  const snapshot = globalThis.structuredClone(context);
  const { source, target, sourceBytes } = validateCombinedApplicationContext(snapshot);
  assert.equal(snapshot.sourceRecovery, "legacy-hb12-detached");
  assert.equal(snapshot.nativeCoordinator, "target");
  assert(/^[a-f0-9]{64}$/u.test(snapshot.sourceObservationSha256));
  // Limit this verifier to the reproduced published Setup-managed source.
  assert.equal(source.activeVersion, "0.1.0-beta.35");
  assert.equal(
    source.manifestSha256,
    "272b131a2d3deaffedee07f94e904f9ec1d822d868b8eb2494b60576f947b2cb",
  );
  const binding = Object.freeze({
    installationRoot: root,
    sourceVersion: source.activeVersion,
    sourceLaunchManifestSha256: source.manifestSha256,
    sourcePointerSha256: sha256(sourceBytes),
    sourceObservationSha256: snapshot.sourceObservationSha256,
    targetVersion: target.activeVersion,
    targetManifestSha256: snapshot.identity.manifestSha256,
  });
  const base = {
    schemaVersion: 1,
    kind: "legacy-source-baseline",
    version: source.activeVersion,
    ready: false,
    readyForWorkspaceOperations: false,
    activationAllowed: false,
  };
  try {
    assert.equal(await authorize(binding), true, "Baseline inspection authorization refused");
    assert.deepEqual(await readBounded(path.join(root, "current.json")), sourceBytes);
    const trust = JSON.parse(await readBounded(path.join(root, "recovery/v1/update-trust.json")));
    assert.equal(trust.schemaVersion, 1);
    const observation = await observe({
      installationRoot: root,
      manifestPath: path.join(
        root,
        "update/recovery-sources",
        target.activeVersion,
        "release.json",
      ),
      manifestSha256: binding.targetManifestSha256,
      bootstrapperVersion: trust.bootstrapperVersion,
      channel: trust.channel,
      sourceRecovery: "legacy-hb12-detached",
    });
    assert(
      observation.schemaVersion === 1 &&
        observation.status === "migration-required" &&
        observation.reason === "legacy-detached-recovery-required" &&
        observation.activationAllowed === false &&
        observation.sourceRecovery === "legacy-hb12-detached" &&
        observation.sourceVersion === source.activeVersion &&
        observation.targetVersion === target.activeVersion &&
        observation.manifestSha256 === binding.targetManifestSha256 &&
        observation.sourceComponentVersion === "0.0.0+cfa606fd4143.hb12" &&
        observation.sourcePointerSha256 === binding.sourcePointerSha256 &&
        observation.sourceEvidenceSha256 === binding.sourceObservationSha256 &&
        Number.isSafeInteger(observation.parentCount) &&
        observation.parentCount >= 0,
      "Original legacy baseline was not restored",
    );
    assert.deepEqual(await readBounded(path.join(root, "current.json")), sourceBytes);
    assert.equal(await authorize(binding), true, "Source or target authentication changed");
    return {
      ...base,
      baselineRestored: true,
      sourceEvidenceSha256: binding.sourceObservationSha256,
    };
  } catch (error) {
    return {
      ...base,
      baselineRestored: false,
      failure: { code: "update.legacy-baseline-not-restored", message: error.message },
    };
  }
}
