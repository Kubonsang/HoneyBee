import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./prepare-fixture.mjs";
import { sha256 } from "./release-manifest.mjs";
import { signReleaseManifest } from "./release-authentication.mjs";
import { recoveryInventoryBytes } from "./recovery-source.mjs";
import { prepareAuthenticatedUpdate } from "./authenticated-preparation.mjs";
import { createPrepareJob, createActivationJob } from "./update-job.mjs";
import { activateAuthenticatedUpdate } from "./activate-authenticated.mjs";

async function setup(service = false) {
  let files;
  const f = await fixture((payload) => {
    const installation = JSON.parse(payload["installation.json"]);
    installation.activity = { protocol: 1, helperSha256: sha256("helper") };
    payload["installation.json"] = JSON.stringify(installation);
    const launch = JSON.parse(payload["launch.json"]);
    launch.installationSha256 = sha256(payload["installation.json"]);
    payload["launch.json"] = JSON.stringify(launch);
    payload["runtime/honeybee-lifecycle.exe"] = "helper";
    for (const name of ["desktop/activity-client.json", "cli/activity-client.json"])
      payload[name] = JSON.stringify({ schemaVersion: 1, protocol: 1 });
    files = { ...payload };
  });
  const root = f.installationRoot,
    runtime = path.join(root, "recovery/v1");
  const inventory = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      { size: Buffer.byteLength(bytes), sha256: sha256(bytes) },
    ]),
  );
  const manifest = JSON.parse(await readFile(path.join(f.stageAttempt, "release.json")));
  if (service) manifest.components.storage.migration.kind = "service-replacement";
  manifest.recovery = {
    schemaVersion: 1,
    inventorySha256: sha256(recoveryInventoryBytes(inventory)),
    launchManifestSha256: inventory["launch.json"].sha256,
  };
  const bytes = Buffer.from(JSON.stringify(manifest)),
    keys = generateKeyPairSync("ed25519");
  await writeFile(path.join(f.stageAttempt, "release.json"), bytes);
  await writeFile(
    path.join(f.stageAttempt, "release.sig.json"),
    signReleaseManifest(bytes, keys.privateKey),
  );
  await mkdir(runtime, { recursive: true });
  await writeFile(
    path.join(runtime, "update-trust.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: "beta",
      bootstrapperVersion: "1.0.0",
      publicKeys: [keys.publicKey.export({ type: "spki", format: "pem" })],
    }),
  );
  const sourceVersion = f.source.currentVersion,
    sourceFiles = {
      "installation.json": JSON.stringify({ activity: { protocol: 1 } }),
      "launch.json": "source launch",
    };
  for (const [name, data] of Object.entries(sourceFiles)) {
    await mkdir(path.join(root, "versions", sourceVersion), { recursive: true });
    await writeFile(path.join(root, "versions", sourceVersion, name), data);
  }
  await writeFile(
    path.join(runtime, "approved-source.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: sourceVersion,
      launchSha256: sha256("source launch"),
      files: Object.fromEntries(
        Object.entries(sourceFiles).map(([name, data]) => [name, sha256(data)]),
      ),
    }),
  );
  const pointer = JSON.stringify({
    schemaVersion: 1,
    generation: 1,
    activeVersion: sourceVersion,
    manifestSha256: sha256("source launch"),
  });
  await writeFile(path.join(root, "current.json"), pointer);
  await writeFile(path.join(root, "HoneyBeeLauncher.exe"), "fixture launcher");
  const observe = async () => ({
    status: service ? "migration-required" : "app-only-candidate",
    activationAllowed: false,
    sourceVersion,
    targetVersion: manifest.version,
    sourceComponentVersion: f.source.storageComponentVersion,
    sourceEvidenceSha256: sha256("service fixture"),
    sourcePointerSha256: sha256(pointer),
    manifestSha256: sha256(bytes),
    parentCount: 0,
    remainingGates: [],
  });

  const options = {
    installationRoot: root,
    stageAttempt: f.stageAttempt,
    expectedManifestSha256: sha256(bytes),
    trustedPublicKeys: [keys.publicKey],
    bootstrapperVersion: "1.0.0",
    channel: "beta",
  };
  const job = await createPrepareJob({ ...options, manifestSha256: sha256(bytes) });
  const result = await prepareAuthenticatedUpdate(options, { observe });
  await writeFile(
    path.join(job.directory, "result.json"),
    JSON.stringify({ schemaVersion: 1, passed: true, requestSha256: job.sha256, result }),
  );
  const activation = await createActivationJob({
    installationRoot: root,
    preparation: job,
    desktopDescriptor: path.join(
      root,
      "update/desktop-sessions/11111111-1111-1111-1111-111111111111.json",
    ),
  });
  const request = JSON.parse(await readFile(path.join(activation.directory, "request.json")));
  return {
    root,
    runtime,
    request,
    observe,
    pointer,
    stage: f.stageAttempt,
    target: manifest.version,
  };
}
for (const outcome of ["cancel", "signature-changed", "source-changed", "target-changed"])
  test(`authenticated activation ${outcome} validates before shutdown`, async () => {
    const f = await setup();
    let called = false;
    if (outcome === "signature-changed")
      await writeFile(path.join(f.stage, "release.sig.json"), "{}");
    if (outcome === "source-changed")
      await writeFile(path.join(f.root, "versions/0.1.0-beta.11/launch.json"), "changed");
    if (outcome === "target-changed")
      await writeFile(path.join(f.root, "versions", f.target, "runtime/node.exe"), "changed");
    const operation = activateAuthenticatedUpdate(
      { installationRoot: f.root, runtime: f.runtime, request: f.request },
      {
        observe: f.observe,
        execute: async (options, hooks) => {
          called = true;
          assert.equal(options.sourcePointerSha256, sha256(f.pointer));
          assert.equal(await hooks.admit(), true);
          assert.equal(await hooks.authorizeHealth({ version: f.target }), true);
          return { state: "Cancelled", restart: "NotRequested" };
        },
      },
    );
    if (outcome === "cancel") assert.equal((await operation).state, "Cancelled");
    else await assert.rejects(operation);
    assert.equal(called, outcome === "cancel");
    assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
  });

for (const change of [null, "signature", "source", "target"])
  test(`external combined runner is reached only after authentication: ${change ?? "valid"}`, async () => {
    const f = await setup(true);
    if (change === "signature") await writeFile(path.join(f.stage, "release.sig.json"), "{}");
    if (change === "source")
      await writeFile(path.join(f.root, "versions/0.1.0-beta.11/launch.json"), "changed");
    if (change === "target")
      await writeFile(path.join(f.root, "versions", f.target, "runtime/node.exe"), "changed");
    let calls = 0;
    const operation = activateAuthenticatedUpdate(
      { installationRoot: f.root, runtime: f.runtime, request: f.request },
      {
        observe: f.observe,
        activateCombined: async ({ sourceBytes, release }) => {
          calls++;
          assert.equal(sha256(sourceBytes), sha256(f.pointer));
          assert.equal(release.manifest.version, f.target);
          return { state: "Cancelled" };
        },
      },
    );
    if (change) await assert.rejects(operation);
    else assert.equal((await operation).state, "Cancelled");
    assert.equal(calls, change ? 0 : 1);
    assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
  });
