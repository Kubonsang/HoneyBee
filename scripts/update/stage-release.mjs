import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { admitRelease, parseReleaseManifest, validateDownloadUrl } from "./release-manifest.mjs";
import { requireDiskSpace } from "./disk-space.mjs";

const writeDurable = async (target, bytes) => {
  const file = await open(target, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
};
export const plainDirectory = async (target) => {
  const resolved = path.resolve(target);
  let cursor = resolved;
  for (;;) {
    const info = await lstat(cursor);
    assert(info.isDirectory() && !info.isSymbolicLink(), "Redirected staging directory");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  assert.equal(
    (await realpath(resolved)).toLowerCase(),
    resolved.toLowerCase(),
    "Redirected staging directory",
  );
};

/** Manual redirects prevent forwarding a request to an unapproved destination. */
export const downloadResponse = async (url, signal, fetchImpl = globalThis.fetch) => {
  let next = validateDownloadUrl(url).href;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    validateDownloadUrl(next, redirects > 0);
    const response = await fetchImpl(next, {
      redirect: "manual",
      signal,
      headers: { "Accept-Encoding": "identity" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      assert(location && redirects < 5, "Invalid or excessive redirect");
      next = new globalThis.URL(location, next).href;
      continue;
    }
    if (
      response.status !== 200 ||
      !response.body ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))
    ) {
      await response.body?.cancel();
      throw new Error("Package response rejected");
    }
    return response;
  }
  throw new Error("Redirect limit reached");
};

/** Staging only: never extracts packages, executes tools, or writes current.json. */
export const stageRelease = async ({
  installationRoot,
  manifestBytes: suppliedBytes,
  manifestSha256,
  source: suppliedSource,
  signal,
  fetchImpl,
  onProgress,
  checkSpace = requireDiskSpace,
}) => {
  assert(onProgress === undefined || typeof onProgress === "function");
  assert(
    Buffer.isBuffer(suppliedBytes) && suppliedBytes.length <= 64 * 1024,
    "Expected bounded manifest bytes",
  );
  const manifestBytes = Buffer.from(suppliedBytes);
  const source = { ...suppliedSource };
  const manifest = parseReleaseManifest(manifestBytes, manifestSha256);
  admitRelease(manifest, source);
  const timeout = globalThis.AbortSignal.timeout(15 * 60 * 1000);
  const boundedSignal = signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
  boundedSignal.throwIfAborted();
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  // Download bytes plus bounded metadata/headroom. Extraction and service backup
  // require their own admission; this check does not reserve capacity for them.
  await checkSpace(root, manifest.packages.application.size + 64 * 1024 * 1024);
  boundedSignal.throwIfAborted();
  const staging = path.join(root, "update");
  try {
    await mkdir(staging);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await plainDirectory(staging);
  const attempt = await mkdtemp(path.join(staging, "stage-"));
  let sequence = 0;
  const record = async (state, details = {}) => {
    await writeDurable(
      path.join(attempt, `${String(++sequence).padStart(3, "0")}-${state}.json`),
      JSON.stringify({
        schemaVersion: 1,
        state,
        version: manifest.version,
        manifestSha256,
        ...details,
      }) + "\n",
    );
  };
  try {
    await writeDurable(path.join(attempt, "release.json"), manifestBytes);
    await record("Downloading", { source });
    const artifact = manifest.packages.application;
    onProgress?.(Object.freeze({ state: "Downloading", received: 0, total: artifact.size }));
    const response = await downloadResponse(artifact.url, boundedSignal, fetchImpl);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== artifact.size)) {
      await response.body.cancel();
      throw new Error("Package Content-Length mismatch");
    }
    const partial = path.join(attempt, "application.zip.partial");
    let file;
    try {
      file = await open(partial, "wx");
    } catch (error) {
      await response.body.cancel();
      throw error;
    }
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const chunk of response.body) {
        boundedSignal.throwIfAborted();
        received += chunk.byteLength;
        assert(received <= artifact.size, "Package exceeds declared size");
        await file.writeFile(chunk);
        hash.update(chunk);
        onProgress?.(Object.freeze({ state: "Downloading", received, total: artifact.size }));
      }
      boundedSignal.throwIfAborted();
      await file.sync();
    } finally {
      await file.close();
    }
    await record("Downloaded", { received });
    assert.equal(received, artifact.size, "Incomplete package");
    assert.equal(hash.digest("hex"), artifact.sha256, "Package SHA-256 mismatch");
    await rename(partial, path.join(attempt, "application.zip"));
    await record("Verified", { packageSha256: artifact.sha256, received });
    onProgress?.(Object.freeze({ state: "Verified", received, total: artifact.size }));
    return {
      schemaVersion: 1,
      state: "Verified",
      attempt,
      version: manifest.version,
      activationAllowed: false,
    };
  } catch (error) {
    // Keep partial files and all earlier records. Even failure-record write failure cannot activate anything.
    try {
      await record("Failed", {
        reason: boundedSignal.aborted ? "cancelled-or-timed-out" : "staging-failed",
      });
    } catch {
      /* Preserve the original failure. */
    }
    throw new Error(`Update staging failed; evidence retained at ${attempt}`, { cause: error });
  }
};
