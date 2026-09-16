import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { prepareAuthenticatedUpdate } from "./authenticated-preparation.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "./recovery-source.mjs";
import { activateAuthenticatedUpdate } from "./activate-authenticated.mjs";

// Invoked only through the bootstrapper's hash-pinned runtime entry point.
const [rootArgument, name, expectedDigest, ...extra] = process.argv.slice(2);
assert(
  rootArgument &&
    !extra.length &&
    /^job-[A-Za-z0-9]+$/u.test(name) &&
    /^[a-f0-9]{64}$/u.test(expectedDigest),
  "Invalid worker arguments",
);
const root = path.resolve(rootArgument);
const runtime = path.resolve(import.meta.dirname, "../..");
assert.equal(runtime.toLowerCase(), path.join(root, "recovery/v1").toLowerCase());
const directory = path.join(root, "update/jobs", name);
await plainDirectory(directory);
const bytes = await readBounded(path.join(directory, "request.json"));
assert.equal(sha256(bytes), expectedDigest, "Update job changed");
const request = JSON.parse(bytes);
assert.deepEqual(
  Object.keys(request).sort(),
  (["activate", "setup-activate"].includes(request.operation)
    ? [
        "schemaVersion",
        "operation",
        "preparationJob",
        "preparationSha256",
        "sourcePointerSha256",
        ...(request.operation === "activate" ? ["desktopSession"] : []),
        "launcherSha256",
      ]
    : ["schemaVersion", "operation", "stage", "manifestSha256", "sourcePointerSha256"]
  ).sort(),
);
assert(
  request.schemaVersion === 1 &&
    ["prepare", "activate", "setup-activate"].includes(request.operation),
);
assert(/^[a-f0-9]{64}$/u.test(request.sourcePointerSha256));
if (request.operation === "prepare") {
  assert(
    /^stage-[A-Za-z0-9]+$/u.test(request.stage) && /^[a-f0-9]{64}$/u.test(request.manifestSha256),
  );
} else {
  assert(/^job-[A-Za-z0-9]+$/u.test(request.preparationJob));
  if (request.operation === "activate") assert(/^[a-f0-9-]{36}$/u.test(request.desktopSession));
  assert(
    /^[a-f0-9]{64}$/u.test(request.preparationSha256) &&
      /^[a-f0-9]{64}$/u.test(request.launcherSha256),
  );
}
const record = async (name, value) => {
  const file = await open(path.join(directory, name), "wx");
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
};
// A second worker cannot silently resume/overwrite an interrupted job.
await record("started.json", { schemaVersion: 1, requestSha256: expectedDigest });
try {
  let result;
  if (["activate", "setup-activate"].includes(request.operation))
    result = await activateAuthenticatedUpdate({
      installationRoot: root,
      runtime,
      request,
      activationJob: { directory, requestSha256: expectedDigest },
    });
  else {
    const pointerBytes = await readBounded(path.join(root, "current.json"));
    assert.equal(sha256(pointerBytes), request.sourcePointerSha256, "Active source changed");
    const pointer = JSON.parse(pointerBytes);
    const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
    assert(
      approved.schemaVersion === 1 &&
        approved.version === pointer.activeVersion &&
        approved.launchSha256 === pointer.manifestSha256,
      "Source has no approved automatic recovery path",
    );
    assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/u.test(approved.version));
    await verifyRecoverySourceFiles(root, approved);
    const trust = JSON.parse(await readBounded(path.join(runtime, "update-trust.json")));
    assert.equal(trust.schemaVersion, 1);
    result = await prepareAuthenticatedUpdate({
      installationRoot: root,
      stageAttempt: path.join(root, "update", request.stage),
      expectedManifestSha256: request.manifestSha256,
      trustedPublicKeys: trust.publicKeys,
      bootstrapperVersion: trust.bootstrapperVersion,
      channel: trust.channel,
    });
    assert.equal(
      sha256(await readBounded(path.join(root, "current.json"))),
      request.sourcePointerSha256,
    );
  }
  await record("result.json", {
    schemaVersion: 1,
    passed: true,
    requestSha256: expectedDigest,
    result,
  });
} catch (error) {
  await record("result.json", {
    schemaVersion: 1,
    passed: false,
    requestSha256: expectedDigest,
    error: error.message,
  });
  process.exitCode = 1;
}
