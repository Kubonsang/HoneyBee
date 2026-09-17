import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { authenticateReleaseManifest } from "../update/release-authentication.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { snapshotRegisteredProject, assertPreserved } from "./preservation.mjs";

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = async (file) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const inputs = await json(path.join(bundle, "inputs.json"));
const completed = await json(path.join(bundle, "remaining-service-result.json"));
assert.equal(completed.remainingServiceBatchPassed, true);
assert.deepEqual(completed.candidate, inputs.candidate);
const root = path.join(process.env.LOCALAPPDATA, "HoneyBee");
const evidence = path.join(bundle, "Public-Evidence");
const receiptPath = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/install-receipt.json",
);
const mode = process.argv[2];
assert(["before", "after"].includes(mode));
const snapshot = await snapshotRegisteredProject({
  installationRoot: root,
  projectId: completed.projectId,
});
const pointer = await json(path.join(root, "current.json"));
const receiptSha256 = sha256(await readFile(receiptPath));
if (mode === "before") {
  assert.equal(pointer.activeVersion, "0.1.0-beta.32");
  const trust = await json(path.join(root, "recovery/v1/update-trust.json"));
  const authenticated = authenticateReleaseManifest(
    await readFile(path.join(evidence, "release.json")),
    await readFile(path.join(evidence, "release.sig.json")),
    trust.publicKeys,
  );
  assert.equal(authenticated.manifestSha256, inputs.candidate.manifestSha256);
  assert.equal(authenticated.manifest.version, "0.1.0-beta.35");
  assert.equal(
    sha256(await readFile(path.join(evidence, "Kubonsang.HoneyBee.yaml"))),
    inputs.publicDelivery.wingetManifestSha256,
  );
  await writeFile(
    path.join(evidence, "before.json"),
    JSON.stringify({
      snapshot,
      receiptSha256,
      targetLaunchSha256: authenticated.manifest.recovery.launchManifestSha256,
    }) + "\n",
    { flag: "wx" },
  );
} else {
  const before = await json(path.join(evidence, "before.json"));
  assertPreserved(before.snapshot, snapshot);
  assert.equal(before.receiptSha256, receiptSha256);
  assert.equal(pointer.activeVersion, "0.1.0-beta.35");
  assert.equal(pointer.manifestSha256, before.targetLaunchSha256);
}
process.stdout.write(
  JSON.stringify({ mode, preserved: true, version: pointer.activeVersion }) + "\n",
);
