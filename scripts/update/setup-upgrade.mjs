import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { stageAuthenticatedRelease } from "./authenticated-release.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "./recovery-source.mjs";
import { dispatchPreparation, dispatchActivation } from "./dispatch-preparation.mjs";
import { sha256 } from "./release-manifest.mjs";
import {
  readInstalledStorage,
  WorkspaceToolResolver,
  WindowsWorkspaceStorage,
} from "../../packages/core/dist/index.js";
import { authorizeLegacySetupSource } from "./legacy-setup-source.mjs";
import { prepareAuthenticatedUpdate } from "./authenticated-preparation.mjs";
import { activateAuthenticatedUpdate } from "./activate-authenticated.mjs";
import { createPrepareJob, createActivationJob } from "./update-job.mjs";
import { trackActivationJob } from "./update-outcome.mjs";
import {
  loadCombinedApplicationContext,
  validateCombinedApplicationContext,
} from "./combined-application.mjs";
import { inspectCombinedJournal } from "./combined-update.mjs";
import {
  createCombinedReleaseAuthorization,
  runCombinedApplicationTransaction,
} from "./installed-combined-update.mjs";
import { createSetupDesktopUpdateTransport } from "./desktop-session.mjs";
import { withDesktopUpdateLifecycle } from "./desktop-update-lifecycle.mjs";
import { revalidateUpdatePlan } from "./update-plan.mjs";
import { verifyPublishedVersion } from "./publish-version.mjs";

export async function findReusableLegacyPreparation(
  { installationRoot, manifestSha256, sourcePointerSha256 },
  { revalidate = revalidateUpdatePlan, verify = verifyPublishedVersion } = {},
) {
  const root = path.resolve(installationRoot),
    jobs = path.join(root, "update/jobs");
  let entries;
  try {
    await plainDirectory(jobs);
    entries = await readdir(jobs, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert(entries.length <= 1024, "Too many Setup preparation jobs");
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    assert(
      entry.isDirectory() && /^job-[A-Za-z0-9]+$/u.test(entry.name),
      "Unknown preparation job",
    );
    const directory = path.join(jobs, entry.name);
    await plainDirectory(directory);
    const bytes = await readBounded(path.join(directory, "request.json"));
    const request = JSON.parse(bytes);
    if (
      request.schemaVersion !== 1 ||
      request.operation !== "prepare" ||
      request.manifestSha256 !== manifestSha256 ||
      request.sourcePointerSha256 !== sourcePointerSha256
    )
      continue;
    let receipt;
    try {
      receipt = JSON.parse(await readBounded(path.join(directory, "result.json")));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (receipt.passed !== true) continue;
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.requestSha256, sha256(bytes));
    const prepared = receipt.result;
    assert.equal(prepared.state, "ReadyForActivation");
    assert.equal(prepared.activationAllowed, false);
    assert.equal(prepared.manifestSha256, manifestSha256);
    assert.equal(prepared.sourcePointerSha256, sourcePointerSha256);
    const planPath = path.resolve(prepared.planPath),
      attempt = path.dirname(planPath);
    assert.equal(path.dirname(attempt), path.join(root, "update"));
    assert(
      /^prepare-[A-Za-z0-9]+$/u.test(path.basename(attempt)) &&
        path.basename(planPath) === "plan.json",
    );
    const planBytes = await readBounded(planPath);
    assert.equal(sha256(planBytes), prepared.planSha256);
    const plan = JSON.parse(planBytes);
    if (plan.identity.sourceRecovery !== "legacy-hb12-detached") continue;
    assert.equal(plan.identity.sourceComponentVersion, "0.0.0+cfa606fd4143.hb12");
    assert.equal(plan.identity.sourcePointerSha256, sourcePointerSha256);
    assert.equal(plan.identity.manifestSha256, manifestSha256);
    const options = {
      installationRoot: root,
      planPath,
      planSha256: prepared.planSha256,
      publicationDirectory: prepared.publicationDirectory,
    };
    await revalidate(options);
    await verify({ ...options, allowServiceCandidate: true });
    return { name: entry.name, sha256: sha256(bytes) };
  }
}

export async function runExternalSetupJob(job, work) {
  const verifyRequest = async () =>
    assert.equal(
      sha256(await readBounded(path.join(job.directory, "request.json"))),
      job.sha256,
      "External Setup job changed",
    );
  await verifyRequest();
  const record = async (name, value) => {
    const file = await open(path.join(job.directory, name), "wx");
    try {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
  };
  await record("started.json", { schemaVersion: 1, requestSha256: job.sha256 });
  try {
    const result = await work();
    await verifyRequest();
    await record("result.json", {
      schemaVersion: 1,
      passed: true,
      requestSha256: job.sha256,
      result,
    });
    return result;
  } catch (error) {
    await record("result.json", {
      schemaVersion: 1,
      passed: false,
      requestSha256: job.sha256,
      error: error.message,
    });
    throw error;
  }
}

// Only the new Setup's own authenticated payload performs the initial read-only
// service inspection. The installed source helper is used later, after original
// bootstrapper/runtime/source authentication has completed.
async function inspectLegacySetupSource({ root, pointer, sourceInstallation, manifest }) {
  if (
    !sourceInstallation ||
    !manifest.components.storage.migration.supportedSourceVersions?.includes(
      "0.0.0+cfa606fd4143.hb12",
    )
  )
    return false;
  const supplied = JSON.parse(await readBounded(path.join(sourceInstallation, "current.json")));
  assert.equal(supplied.activeVersion, manifest.version);
  assert.equal(supplied.manifestSha256, manifest.recovery?.launchManifestSha256);
  const options = await readInstalledStorage(
    path.join(sourceInstallation, "versions", supplied.activeVersion),
  );
  const tools = new WorkspaceToolResolver(options).resolve();
  assert(tools?.provenance === "managed");
  assert.equal(tools.expectedComponentVersion, manifest.components.storage.componentVersion);
  const evidence = await new WindowsWorkspaceStorage().serviceEvidence(tools);
  if (evidence.receipt.componentVersion !== "0.0.0+cfa606fd4143.hb12") return false;
  assert.equal(
    evidence.executableSha256,
    "0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3",
    "Unsupported legacy service executable",
  );
  assert.equal(evidence.receipt.executableSha256, evidence.executableSha256);
  assert.equal(evidence.receipt.workspaceRoot, path.join(root, "Workspaces"));
  assert.equal(pointer.activeVersion, "0.1.0-beta.35");
  await authorizeLegacySetupSource(root);
  return true;
}

/** Keep the initially installed bootstrapper while repairing a later approved
 * application. Both the original infrastructure receipt and native runtime pin
 * must match; this function never repairs or replaces infrastructure. */
export async function authorizeMatchingSetup(
  { installationRoot, sourceInstallation, verifyActive = true },
  { run = promisify(execFile) } = {},
) {
  const root = path.resolve(installationRoot),
    runtime = path.join(root, "recovery/v1");
  const original = JSON.parse(
    await readBounded(path.join(root, ".setup-pending/prepared.json"), 8 * 1024 * 1024),
  );
  assert.equal(original.schemaVersion, 1);
  for (const name of ["HoneyBeeLauncher.exe", "bin/honeybee.exe"])
    assert.equal(
      sha256(await readBounded(path.join(root, name), 8 * 1024 * 1024)),
      original.inventory[name],
      "Original bootstrapper or shim requires matching Setup repair",
    );
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
    sha256(await readBounded(path.join(runtime, "manifest.json"))),
    checked.recoveryManifestSha256,
  );
  const pointerBytes = await readBounded(path.join(root, "current.json")),
    pointer = JSON.parse(pointerBytes);
  const supplied = JSON.parse(await readBounded(path.join(sourceInstallation, "current.json")));
  assert.equal(
    supplied.activeVersion,
    pointer.activeVersion,
    "Repair Setup version differs from active version",
  );
  assert.equal(
    supplied.manifestSha256,
    pointer.manifestSha256,
    "Repair Setup launch identity differs",
  );
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(sourceInstallation, approved);
  if (verifyActive) await verifyRecoverySourceFiles(root, approved);
  assert.deepEqual(await readBounded(path.join(root, "current.json")), pointerBytes);
  return { runtime };
}

/** Local media is transport only: installed trust, release admission and the
 * ordinary pinned worker still authenticate and execute every update step. */
export async function createEmbeddedReleaseTransport(directory, trustedPublicKeys) {
  directory = path.resolve(directory);
  await plainDirectory(directory);
  const bytes = await readBounded(path.join(directory, "release.json"), 65536);
  const signature = await readBounded(path.join(directory, "release.sig.json"), 4096);
  const authenticated = authenticateReleaseManifest(bytes, signature, trustedPublicKeys);
  const artifact = authenticated.manifest.packages.application;
  const base = new globalThis.URL(".", artifact.url);
  const manifestUrl = new globalThis.URL("release.json", base).href;
  const signatureUrl = new globalThis.URL("release.sig.json", base).href;
  assert(![manifestUrl, signatureUrl].includes(artifact.url), "Package URL collides with metadata");
  const archive = path.join(directory, "application.zip");
  const info = await lstat(archive);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size === artifact.size,
    "Embedded application archive is missing or has the wrong size",
  );
  return {
    authenticated,
    manifestUrl,
    signatureUrl,
    fetchImpl: async (url) => {
      if (url === manifestUrl) return new globalThis.Response(bytes);
      if (url === signatureUrl) return new globalThis.Response(signature);
      assert.equal(url, artifact.url, "Setup requested an unrelated package");
      return new globalThis.Response(Readable.toWeb(createReadStream(archive)), {
        headers: { "content-length": String(info.size) },
      });
    },
  };
}

export async function prepareSetupUpgrade({
  installationRoot,
  mediaDirectory,
  expectedVersion,
  allowServiceUpdate,
  sourceInstallation,
}) {
  const root = path.resolve(installationRoot),
    runtime = path.join(root, "recovery/v1");
  await plainDirectory(root);
  const pointerBytes = await readBounded(path.join(root, "current.json"));
  const pointer = JSON.parse(pointerBytes);
  const trust = JSON.parse(await readBounded(path.join(runtime, "update-trust.json")));
  assert.equal(trust.schemaVersion, 1);
  const media = await createEmbeddedReleaseTransport(mediaDirectory, trust.publicKeys);
  assert.equal(
    media.authenticated.manifest.version,
    expectedVersion,
    "Setup and update media versions differ",
  );
  if (media.authenticated.manifest.components.storage.migration.kind === "service-replacement")
    assert.equal(allowServiceUpdate, true, "Service update requires interactive Setup");
  const legacyRecovery = await inspectLegacySetupSource({
    root,
    pointer,
    sourceInstallation,
    manifest: media.authenticated.manifest,
  });
  const capabilities = JSON.parse(
    (
      await promisify(execFile)(
        path.join(root, "HoneyBeeLauncher.exe"),
        ["--installation-capabilities"],
        { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      )
    ).stdout,
  );
  assert(
    capabilities.schemaVersion === 1 && capabilities.setupActivation === 1,
    "Installed bootstrapper does not support Setup upgrades; existing installation preserved",
  );
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(root, approved);
  if (legacyRecovery) {
    const preparation = await findReusableLegacyPreparation({
      installationRoot: root,
      manifestSha256: media.authenticated.manifestSha256,
      sourcePointerSha256: sha256(pointerBytes),
    });
    if (preparation) return { installationRoot: root, preparation, externalSetupRecovery: true };
  }
  const installation = JSON.parse(
    await readBounded(path.join(root, "versions", pointer.activeVersion, "installation.json")),
  );
  const staged = await stageAuthenticatedRelease({
    installationRoot: root,
    ...media,
    trustedPublicKeys: trust.publicKeys,
    source: {
      currentVersion: pointer.activeVersion,
      bootstrapperVersion: trust.bootstrapperVersion,
      channel: trust.channel,
      storageComponentVersion: legacyRecovery
        ? "0.0.0+cfa606fd4143.hb12"
        : installation.componentVersion,
    },
    signal: globalThis.AbortSignal.timeout(30 * 60 * 1000),
  });
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    pointerBytes,
    "Active source changed",
  );
  if (legacyRecovery) {
    const job = await createPrepareJob({
      installationRoot: root,
      stageAttempt: staged.attempt,
      manifestSha256: staged.manifestSha256,
    });
    await runExternalSetupJob(job, () =>
      prepareAuthenticatedUpdate({
        installationRoot: root,
        stageAttempt: staged.attempt,
        expectedManifestSha256: staged.manifestSha256,
        trustedPublicKeys: trust.publicKeys,
        bootstrapperVersion: trust.bootstrapperVersion,
        channel: trust.channel,
        sourceRecovery: "legacy-hb12-detached",
      }),
    );
    return {
      installationRoot: root,
      preparation: { name: job.name, sha256: job.sha256 },
      externalSetupRecovery: true,
    };
  }
  const preparation = await dispatchPreparation({ installationRoot: root, stage: staged });
  return { installationRoot: root, preparation };
}

export async function upgradeFromSetup(options) {
  const {
    installationRoot: root,
    preparation,
    externalSetupRecovery,
  } = await prepareSetupUpgrade(options);
  let state;
  if (externalSetupRecovery) {
    const job = await createActivationJob({
      installationRoot: root,
      preparation,
      setupActivation: true,
    });
    await trackActivationJob(root, job);
    const requestBytes = await readBounded(path.join(job.directory, "request.json"));
    assert.equal(sha256(requestBytes), job.sha256, "External Setup activation job changed");
    const request = JSON.parse(requestBytes);
    const result = await runExternalSetupJob(job, () =>
      activateAuthenticatedUpdate({
        installationRoot: root,
        runtime: path.join(root, "recovery/v1"),
        request,
        activationJob: { directory: job.directory, requestSha256: job.sha256 },
        externalSetupRecovery: true,
      }),
    );
    assert(["Committed", "RolledBack", "Cancelled"].includes(result.state));
    assert.notEqual(
      result.restart,
      "Failed",
      "Recovery completed but Desktop restart failed; evidence retained",
    );
    state = result.state;
  } else
    state = await dispatchActivation({
      installationRoot: root,
      preparation,
      setupActivation: true,
    });
  return {
    schemaVersion: 1,
    installed: true,
    ready: state === "Committed",
    state,
    evidence: path.join(root, "update/jobs"),
    restarted: state !== "Cancelled",
  };
}

// The installed beta.35 runtime cannot apply the new legacy baseline verifier.
// A rerun of the authenticated new Setup owns this explicit recovery lane. It
// reuses the existing protected native transaction; it never stages a second one.
export async function resumeLegacySetupUpgrade({
  installationRoot,
  mediaDirectory,
  expectedVersion,
  allowServiceUpdate,
}) {
  const root = path.resolve(installationRoot),
    parent = path.join(root, "update/combined");
  let entries;
  try {
    await plainDirectory(parent);
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert(entries.length <= 256, "Too many combined journals");
  const pending = [];
  for (const entry of entries) {
    assert(entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name), "Unknown combined journal");
    const context = await loadCombinedApplicationContext(root, entry.name);
    if (context.sourceRecovery !== "legacy-hb12-detached") continue;
    const { state } = await inspectCombinedJournal({
      installationRoot: root,
      transactionDirectory: path.join(parent, entry.name),
      sourcePointerSha256: context.identity.sourcePointerSha256,
    });
    if (["Committed", "RolledBack"].includes(state)) continue;
    const pointers = validateCombinedApplicationContext(context);
    assert.equal(
      pointers.target.activeVersion,
      expectedVersion,
      "Interrupted recovery needs its matching Setup version",
    );
    pending.push({ context, ...pointers });
  }
  if (!pending.length) return;
  assert.equal(pending.length, 1, "Multiple interrupted legacy updates require diagnosis");
  assert.equal(allowServiceUpdate, true, "Recovery requires interactive Setup");
  const { context, source, target, sourceBytes, targetBytes } = pending[0];
  const { runtime, currentPointerBytes } = await authorizeLegacySetupSource(root, {
    sourcePointerBytes: sourceBytes,
    targetPointerBytes: targetBytes,
  });
  const trust = JSON.parse(await readBounded(path.join(runtime, "update-trust.json")));
  assert.equal(trust.schemaVersion, 1);
  const media = await createEmbeddedReleaseTransport(mediaDirectory, trust.publicKeys);
  assert.equal(
    media.authenticated.manifestSha256,
    context.identity.manifestSha256,
    "Recovery Setup release differs from pending transaction",
  );
  assert.equal(media.authenticated.manifest.version, target.activeVersion);
  assert.equal(media.authenticated.manifest.recovery?.launchManifestSha256, target.manifestSha256);
  const verifyRelease = createCombinedReleaseAuthorization(root, runtime, context);
  await verifyRelease(path.join(root, "versions", source.activeVersion));
  await verifyRelease(path.join(root, "versions", target.activeVersion));
  const transport = await createSetupDesktopUpdateTransport({ installationRoot: root });
  const attempts = path.join(root, "update/recovery-attempts");
  await mkdir(attempts, { recursive: true });
  await plainDirectory(attempts);
  const evidence = await mkdtemp(path.join(attempts, "legacy-setup-"));
  try {
    const result = await withDesktopUpdateLifecycle(
      {
        installationRoot: root,
        sourcePointerSha256: sha256(currentPointerBytes),
        launcherSha256: context.launcherSha256,
      },
      {
        ...transport,
        authorizeRestart: async ({ state, pointerSha256 }) => {
          const expected = state === "Committed" ? targetBytes : sourceBytes;
          assert.equal(pointerSha256, sha256(expected));
          return verifyRelease(
            path.join(
              root,
              "versions",
              state === "Committed" ? target.activeVersion : source.activeVersion,
            ),
          );
        },
      },
      (activity) =>
        runCombinedApplicationTransaction({
          root,
          runtime,
          context,
          activity,
          verifyRelease,
          recover: true,
        }),
    );
    await writeFile(
      path.join(evidence, "result.json"),
      JSON.stringify({ schemaVersion: 1, identitySha256: context.identitySha256, result }) + "\n",
      { flag: "wx" },
    );
    assert.notEqual(
      result.restart,
      "Failed",
      "Recovery finished but Desktop restart failed; evidence retained",
    );
    return {
      schemaVersion: 1,
      installed: true,
      ready: result.state === "Committed",
      state: result.state,
      evidence,
      restarted: result.state !== "Cancelled",
      recovered: true,
    };
  } catch (error) {
    await writeFile(
      path.join(evidence, "failure.json"),
      JSON.stringify({
        schemaVersion: 1,
        identitySha256: context.identitySha256,
        error: error.message,
      }) + "\n",
      { flag: "wx" },
    );
    throw error;
  }
}
