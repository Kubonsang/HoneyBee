import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "./recovery-source.mjs";

// Exact files extracted from the published beta.35 Setup, whose SHA-256 is
// 643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04.
// External Setup cannot inherit the old launcher's trust merely by reading a
// writable approved-source.json or asking an unverified executable about itself.
export const legacySetupSource = Object.freeze({
  version: "0.1.0-beta.35",
  launchManifestSha256: "272b131a2d3deaffedee07f94e904f9ec1d822d868b8eb2494b60576f947b2cb",
  infrastructure: Object.freeze({
    "HoneyBeeLauncher.exe": "0bd74330a9e03c1b44590b49cfd4b156140d17c2b9a906af89b57da6a505a00b",
    "bin/honeybee.exe": "8df2da78634243c00dbbdae10f481f0665e131325b84131a3754f4547dfddc78",
    "recovery/v1/manifest.json": "88f41df0409a41988ab7222e27cbf052c54521928ef844f8108d4f9896efc624",
    "recovery/v1/update-trust.json":
      "da66fae399f0e108cafe2f7815c02648be802d24e081d801624a3503bcddc669",
    "recovery/v1/approved-source.json":
      "fe31c650cdeb9460a0fa10e43ddfc25c9cde38945968a7d363a89b5040b4583c",
  }),
});

async function authenticateSource(root, runtime, pointer) {
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(root, approved);
  return true;
}

// Inspection only. No installation, replacement, pointer write or service RPC.
export async function authorizeLegacySetupSource(
  installationRoot,
  {
    digest = async (file) => sha256(await readBounded(file, 8 * 1024 * 1024)),
    run = promisify(execFile),
    authorizeSource = authenticateSource,
    sourcePointerBytes,
    targetPointerBytes,
  } = {},
) {
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  const currentPointerBytes = await readBounded(path.join(root, "current.json"));
  if (sourcePointerBytes !== undefined) {
    assert(Buffer.isBuffer(sourcePointerBytes) && Buffer.isBuffer(targetPointerBytes));
    sourcePointerBytes = Buffer.from(sourcePointerBytes);
    targetPointerBytes = Buffer.from(targetPointerBytes);
    assert(
      currentPointerBytes.equals(sourcePointerBytes) ||
        currentPointerBytes.equals(targetPointerBytes),
      "Unknown pointer blocks external Setup recovery",
    );
  } else assert.equal(targetPointerBytes, undefined);
  const pointerBytes = sourcePointerBytes ?? currentPointerBytes;
  const pointer = JSON.parse(pointerBytes);
  assert.equal(pointer.schemaVersion, 1);
  assert(Number.isSafeInteger(pointer.generation) && pointer.generation > 0);
  assert.equal(pointer.activeVersion, legacySetupSource.version, "Unsupported legacy Setup source");
  assert.equal(pointer.manifestSha256, legacySetupSource.launchManifestSha256);
  const verifyInfrastructure = async () => {
    for (const [relative, expected] of Object.entries(legacySetupSource.infrastructure)) {
      assert.equal(
        await digest(path.join(root, relative)),
        expected,
        "Original legacy Setup infrastructure differs: " + relative,
      );
    }
  };
  await verifyInfrastructure();
  const checked = JSON.parse(
    (
      await run(path.join(root, "HoneyBeeLauncher.exe"), ["--verify-recovery-runtime"], {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 65536,
      })
    ).stdout,
  );
  assert.equal(checked.schemaVersion, 1);
  assert.equal(
    checked.recoveryManifestSha256,
    legacySetupSource.infrastructure["recovery/v1/manifest.json"],
  );
  const runtime = path.join(root, "recovery/v1");
  assert.equal(
    await authorizeSource(root, runtime, pointer),
    true,
    "Original source authentication refused",
  );
  await verifyInfrastructure();
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    currentPointerBytes,
    "Source changed during external Setup authorization",
  );
  return {
    root,
    runtime,
    pointer,
    pointerBytes,
    currentPointerBytes,
    launcherSha256: legacySetupSource.infrastructure["HoneyBeeLauncher.exe"],
  };
}
