import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./prepare-fixture.mjs";
import { signReleaseManifest } from "./release-authentication.mjs";
import { prepareAuthenticatedUpdate } from "./authenticated-preparation.mjs";
import { sha256 } from "./release-manifest.mjs";
import { recoveryInventoryBytes } from "./recovery-source.mjs";
const keys = generateKeyPairSync("ed25519");
async function setup(withRecovery = false) {
  let inventory;
  const f = await fixture((files) => {
    inventory = Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        { size: Buffer.byteLength(bytes), sha256: sha256(bytes) },
      ]),
    );
  });
  const pointer = await readFile(path.join(f.installationRoot, "current.json"));
  await mkdir(path.join(f.installationRoot, "versions", f.source.currentVersion), {
    recursive: true,
  });
  await writeFile(
    path.join(f.installationRoot, "versions", f.source.currentVersion, "sentinel"),
    "preserve",
  );
  let bytes = await readFile(path.join(f.stageAttempt, "release.json"));
  if (withRecovery) {
    const manifest = JSON.parse(bytes);
    manifest.recovery = {
      schemaVersion: 1,
      inventorySha256: sha256(recoveryInventoryBytes(inventory)),
      launchManifestSha256: inventory["launch.json"].sha256,
    };
    bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path.join(f.stageAttempt, "release.json"), bytes);
    f.manifestSha256 = sha256(bytes);
  }
  await writeFile(
    path.join(f.stageAttempt, "release.sig.json"),
    signReleaseManifest(bytes, keys.privateKey),
  );
  const options = {
    ...f,
    expectedManifestSha256: f.manifestSha256,
    trustedPublicKeys: [keys.publicKey],
    bootstrapperVersion: f.source.bootstrapperVersion,
    channel: f.source.channel,
  };
  const observation = {
    status: "app-only-candidate",
    activationAllowed: false,
    sourceVersion: f.source.currentVersion,
    targetVersion: "0.1.0-beta.12",
    sourceComponentVersion: f.source.storageComponentVersion,
    sourceEvidenceSha256: sha256("fixed test evidence"),
    sourcePointerSha256: sha256(pointer),
    manifestSha256: f.manifestSha256,
    parentCount: 0,
    remainingGates: [],
  };
  return { options, pointer, observation, observe: async () => ({ ...observation }) };
}
async function preserved({ options, pointer }) {
  assert.deepEqual(await readFile(path.join(options.installationRoot, "current.json")), pointer);
  assert.equal(
    await readFile(path.join(options.installationRoot, "user-state"), "utf8"),
    "preserve",
  );
  assert.equal(
    await readFile(
      path.join(options.installationRoot, "versions", options.source.currentVersion, "sentinel"),
      "utf8",
    ),
    "preserve",
  );
}
test("signed stage produces a real verified inactive publication and durable receipt", async () => {
  const f = await setup();
  const result = await prepareAuthenticatedUpdate(f.options, { observe: f.observe });
  assert.equal(result.state, "ReadyForActivation");
  assert.equal(result.activationAllowed, false);
  assert.equal(result.manifestSha256, f.options.manifestSha256);
  assert.equal(result.sourcePointerSha256, sha256(f.pointer));
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(path.dirname(result.planPath), "authenticated-preparation.json")),
    ),
    result,
  );
  assert(
    (await readdir(path.join(f.options.installationRoot, "versions"))).includes(result.version),
  );
  await preserved(f);
});
test("authenticated service migration publishes an inactive candidate without switching the app", async () => {
  const f = await setup(true);
  const file = path.join(f.options.stageAttempt, "release.json");
  const manifest = JSON.parse(await readFile(file));
  manifest.components.storage.migration = {
    kind: "service-replacement",
    supportedSourceVersions: ["older.managed.service"],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(file, bytes);
  await writeFile(
    path.join(f.options.stageAttempt, "release.sig.json"),
    signReleaseManifest(bytes, keys.privateKey),
  );
  f.options.expectedManifestSha256 = sha256(bytes);
  f.observation.manifestSha256 = sha256(bytes);
  f.observation.sourceComponentVersion = "older.managed.service";
  f.observation.status = "migration-required";
  const result = await prepareAuthenticatedUpdate(f.options, { observe: f.observe });
  assert.equal(result.state, "ReadyForActivation");
  assert.equal(result.activationAllowed, false);
  const plan = JSON.parse(await readFile(result.planPath));
  assert.equal(plan.identity.status, "migration-required");
  await preserved(f);
});
for (const failure of [
  "signature",
  "manifest",
  "wrong-pin",
  "blocked-source",
  "migration",
  "wrong-directory",
]) {
  test(`preparation admission rejects ${failure} before extraction/publication`, async () => {
    const f = await setup();
    if (failure === "signature")
      await writeFile(path.join(f.options.stageAttempt, "release.sig.json"), "{}");
    if (failure === "manifest")
      await writeFile(path.join(f.options.stageAttempt, "release.json"), "{}");
    if (failure === "wrong-pin") f.options.expectedManifestSha256 = "0".repeat(64);
    if (failure === "blocked-source") f.observation.status = "blocked";
    if (failure === "migration") {
      const manifest = JSON.parse(
        await readFile(path.join(f.options.stageAttempt, "release.json")),
      );
      manifest.components.storage.migration.kind = "service-replacement";
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(path.join(f.options.stageAttempt, "release.json"), bytes);
      await writeFile(
        path.join(f.options.stageAttempt, "release.sig.json"),
        signReleaseManifest(bytes, keys.privateKey),
      );
      f.options.expectedManifestSha256 = sha256(bytes);
    }
    if (failure === "wrong-directory") f.options.stageAttempt = f.options.installationRoot;
    let planned = false;
    await assert.rejects(
      prepareAuthenticatedUpdate(f.options, {
        observe: f.observe,
        plan: async () => {
          planned = true;
          throw new Error("must not plan");
        },
      }),
    );
    assert.equal(planned, false);
    await preserved(f);
  });
}
test("signature mutation during real preflight cannot reach planning", async () => {
  const f = await setup();
  let calls = 0;
  await assert.rejects(
    prepareAuthenticatedUpdate(f.options, {
      observe: async () => {
        calls++;
        await writeFile(path.join(f.options.stageAttempt, "release.sig.json"), "{}");
        return f.observation;
      },
    }),
  );
  assert.equal(calls, 1);
  await preserved(f);
});

test("real inactive publication preserves the signed recovery inventory before completion", async () => {
  const f = await setup(true);
  const result = await prepareAuthenticatedUpdate(f.options, { observe: f.observe });
  const proof = path.join(f.options.installationRoot, "update/recovery-sources", result.version);
  const manifest = JSON.parse(await readFile(path.join(proof, "release.json")));
  const inventory = JSON.parse(await readFile(path.join(proof, "inventory.json")));
  assert.equal(sha256(recoveryInventoryBytes(inventory.files)), manifest.recovery.inventorySha256);
  assert.deepEqual(
    await readFile(path.join(proof, "release.sig.json")),
    await readFile(path.join(f.options.stageAttempt, "release.sig.json")),
  );
  await preserved(f);
});
