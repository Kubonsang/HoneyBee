import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { authenticateSetupDescriptor, setupAssetUrl } from "./setup-descriptor.mjs";
import { compareVersions, sha256 } from "./release-manifest.mjs";
import { discoverRelease } from "./release-discovery.mjs";
import { downloadResponse, plainDirectory } from "./stage-release.mjs";
import { readBounded } from "./prepare-release.mjs";
import { requireDiskSpace } from "./disk-space.mjs";

export const terminalRecoveryStates = ["Succeeded", "RolledBack", "Cancelled", "Failed", "Blocked"];
export const recoveryStates = [
  "Checking",
  "Downloading",
  "Review",
  "Starting",
  "Running",
  "Verifying",
  "Unresolved",
  ...terminalRecoveryStates,
];
const jobPattern = /^job-[a-f0-9-]{36}$/u;
const now = () => new Date().toISOString();
export const writeRecoveryFile = async (file, value) => {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export function setupRecoveryRoute({ source, manifest, intent }) {
  assert(["repair", "update"].includes(intent));
  assert.equal(source.installation, "managed", "Setup recovery requires a managed installation");
  assert.equal(
    source.identityVerified,
    true,
    "Installation ownership or integrity requires attention",
  );
  assert.equal(source.channel, manifest.channel, "Recovery channel differs");
  assert(
    compareVersions(source.bootstrapperVersion, manifest.minimumBootstrapperVersion) >= 0,
    "Bootstrapper too old",
  );
  const difference = compareVersions(manifest.version, source.currentVersion);
  assert(
    difference >= 0 && compareVersions(source.currentVersion, manifest.minimumSourceVersion) >= 0,
    "Unsupported source version",
  );
  const storage = manifest.components.storage;
  assert(
    storage.migration.supportedSourceVersions.includes(source.storageComponentVersion),
    "Unsupported storage source",
  );
  if (difference === 0) {
    assert.equal(
      source.storageComponentVersion,
      storage.componentVersion,
      "Same-version Setup cannot migrate an unknown service",
    );
    return "setup-repair";
  }
  assert.equal(intent, "update", "Repair must use the installed application version");
  if (source.storageComponentVersion === storage.componentVersion) return "application-update";
  assert.equal(storage.migration.kind, "service-replacement");
  if (source.storageComponentVersion === "0.0.0+cfa606fd4143.hb12")
    assert(
      source.currentVersion === "0.1.0-beta.35" && source.legacyVerified === true,
      "Unverified legacy source",
    );
  return "setup-transition";
}

export async function readSetupMetadata(url, limit, signal, fetchImpl = globalThis.fetch) {
  const response = await downloadResponse(url, signal, fetchImpl);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      assert(size <= limit, "Recovery metadata exceeds limit");
      chunks.push(Buffer.from(chunk));
    }
    const declared = response.headers.get("content-length");
    if (declared !== null)
      assert(/^\d+$/u.test(declared) && Number(declared) === size, "Incomplete recovery metadata");
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
}

export async function discoverSetupRecovery({
  source,
  intent,
  trustedPublicKeys,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const bounded = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(60000)]);
  let version = source.currentVersion;
  if (intent === "update") {
    const offered = await discoverRelease({
      source,
      trustedPublicKeys,
      signal: bounded,
      fetchImpl,
    });
    if (offered.state === "Available") version = offered.manifest.version;
  }
  const metadata = {};
  for (const [name, limit] of [
    ["release.json", 65536],
    ["release.sig.json", 4096],
    ["setup.json", 16384],
    ["setup.sig.json", 4096],
  ])
    metadata[name] = await readSetupMetadata(
      setupAssetUrl(version, name),
      limit,
      bounded,
      fetchImpl,
    );
  const release = authenticateReleaseManifest(
    metadata["release.json"],
    metadata["release.sig.json"],
    trustedPublicKeys,
  );
  assert.equal(release.manifest.version, version);
  const setup = authenticateSetupDescriptor(
    metadata["setup.json"],
    metadata["setup.sig.json"],
    trustedPublicKeys,
    release,
  );
  return {
    metadata,
    release,
    setup,
    route: setupRecoveryRoute({ source, manifest: release.manifest, intent }),
  };
}

/** A separate OS lock serializes recovery coordinators without holding Setup's transaction lock. */
export async function withSetupRecoveryLock(helper, root, work) {
  const directory = path.join(root, "update");
  await mkdir(directory, { recursive: true });
  await plainDirectory(directory);
  const child = spawn(helper, ["recovery-lock", directory], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.on("error", () => {});
  let held = false;
  const finished = new Promise((resolve) => {
    child.once("close", resolve);
    child.once("error", resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("close", () => reject(new Error("Another Setup recovery is active")));
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.replaceAll("\r\n", "\n") === "LOCKED\n") {
          held = true;
          resolve();
        } else if (output.length > 64) reject(new Error("Invalid recovery lock response"));
      });
    });
    const assertHeld = () =>
      assert(held && child.exitCode === null && child.signalCode === null, "Recovery lock lost");
    return await work(assertHeld);
  } finally {
    child.stdin.end();
    await finished;
  }
}

export async function recoveryJob(root, jobId) {
  assert(jobPattern.test(jobId), "Invalid recovery job identity");
  const directory = path.join(path.resolve(root), "update/setup-recovery", jobId);
  await plainDirectory(directory);
  const bytes = await readBounded(path.join(directory, "request.json"));
  const request = JSON.parse(bytes);
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.jobId, jobId);
  assert(["setup-repair", "setup-transition"].includes(request.route));
  assert(["repair", "update"].includes(request.intent));
  compareVersions(request.sourceVersion, request.version);
  assert(/^[a-f0-9]{64}$/u.test(request.sourcePointerSha256));
  assert(Number.isFinite(Date.parse(request.createdAt)));
  return { directory, request, requestSha256: sha256(bytes) };
}
export async function recoveryEvents(job) {
  const names = (await readdir(job.directory))
    .filter((name) => /^event-\d{6}\.json$/u.test(name))
    .sort();
  assert(names.length <= 10000, "Too many recovery events");
  const events = [];
  for (const name of names) {
    const value = JSON.parse(await readBounded(path.join(job.directory, name), 4096));
    assert.equal(value.requestSha256, job.requestSha256);
    assert(recoveryStates.includes(value.state) && Number.isFinite(Date.parse(value.at)));
    events.push(value);
  }
  return events;
}
export async function recordRecoveryEvent(job, state, details = {}) {
  assert(recoveryStates.includes(state));
  const events = await recoveryEvents(job);
  await writeRecoveryFile(
    path.join(job.directory, `event-${String(events.length + 1).padStart(6, "0")}.json`),
    JSON.stringify({
      ...details,
      schemaVersion: 1,
      state,
      at: now(),
      requestSha256: job.requestSha256,
    }) + "\n",
  );
}
export async function listRecoveryJobs(root) {
  const parent = path.join(root, "update/setup-recovery");
  let names;
  try {
    await plainDirectory(parent);
    names = await readdir(parent);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  assert(names.length <= 256, "Recovery history requires attention");
  const jobs = [];
  for (const name of names) {
    const job = await recoveryJob(root, name);
    jobs.push({ ...job, events: await recoveryEvents(job) });
  }
  return jobs.sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
}

export async function prepareSetupRecovery({
  root,
  source,
  intent,
  offer,
  signal,
  onProgress,
  fetchImpl = globalThis.fetch,
}) {
  assert.notEqual(
    offer.route,
    "application-update",
    "Use the existing authenticated application updater",
  );
  const pending = (await listRecoveryJobs(root)).filter(
    (job) => !terminalRecoveryStates.includes(job.events.at(-1)?.state),
  );
  assert.equal(
    pending.length,
    0,
    "Resolve the existing recovery operation before starting another",
  );
  await requireDiskSpace(root, offer.setup.descriptor.setup.size + 64 * 1024 * 1024);
  const parent = path.join(root, "update/setup-recovery");
  await mkdir(parent, { recursive: true });
  await plainDirectory(parent);
  const jobId = `job-${randomUUID()}`;
  const directory = path.join(parent, jobId);
  await mkdir(directory);
  const pointer = await readBounded(path.join(root, "current.json"));
  assert.equal(JSON.parse(pointer).activeVersion, source.currentVersion);
  const request = {
    schemaVersion: 1,
    jobId,
    route: offer.route,
    intent,
    sourceVersion: source.currentVersion,
    sourcePointerSha256: sha256(pointer),
    version: offer.release.manifest.version,
    createdAt: now(),
  };
  await writeRecoveryFile(path.join(directory, "request.json"), JSON.stringify(request) + "\n");
  await writeRecoveryFile(path.join(directory, "source.json"), pointer);
  const job = await recoveryJob(root, jobId);
  try {
    for (const [name, bytes] of Object.entries(offer.metadata))
      await writeRecoveryFile(path.join(directory, name), bytes);
    const artifact = offer.setup.descriptor.setup;
    await recordRecoveryEvent(job, "Downloading");
    const bounded = globalThis.AbortSignal.any([
      signal,
      globalThis.AbortSignal.timeout(15 * 60 * 1000),
    ]);
    const response = await downloadResponse(artifact.url, bounded, fetchImpl);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== artifact.size)) {
      await response.body.cancel();
      throw new Error("Setup Content-Length mismatch");
    }
    const file = await open(path.join(directory, "HoneyBeeSetup.exe"), "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const chunk of response.body) {
        bounded.throwIfAborted();
        received += chunk.byteLength;
        assert(received <= artifact.size, "Setup exceeds signed size");
        await file.writeFile(chunk);
        hash.update(chunk);
        onProgress?.({ jobId, received, total: artifact.size });
      }
      bounded.throwIfAborted();
      assert.equal(received, artifact.size);
      assert.equal(hash.digest("hex"), artifact.sha256, "Setup download digest differs");
      await file.sync();
    } finally {
      await file.close();
    }
    assert.deepEqual(
      await readBounded(path.join(root, "current.json")),
      pointer,
      "Installation changed while downloading",
    );
    await recordRecoveryEvent(job, "Review");
    return job;
  } catch (error) {
    await recordRecoveryEvent(job, signal.aborted ? "Cancelled" : "Failed", {
      code: signal.aborted ? "recovery.cancelled" : "recovery.download-failed",
      preservation: "unchanged",
    });
    throw error;
  }
}
