import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { compareVersions } from "./release-manifest.mjs";
import { fetchAuthenticatedRelease } from "./authenticated-release.mjs";

export const releaseIndexUrl =
  "https://api.github.com/repos/Kubonsang/HoneyBee/releases?per_page=100";

/** The GitHub index routes discovery only; release assets still require publisher authentication. */
export const discoverRelease = async ({
  source,
  trustedPublicKeys,
  signal,
  fetchImpl = globalThis.fetch,
}) => {
  source = { ...source };
  trustedPublicKeys = [...trustedPublicKeys];
  assert(["beta", "stable"].includes(source.channel));
  compareVersions(source.currentVersion, source.currentVersion);
  const timeout = globalThis.AbortSignal.timeout(30000);
  const boundedSignal = signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
  boundedSignal.throwIfAborted();
  const response = await fetchImpl(releaseIndexUrl, {
    redirect: "error",
    signal: boundedSignal,
    headers: { Accept: "application/vnd.github+json", "Accept-Encoding": "identity" },
  });
  if (
    response.status !== 200 ||
    !response.body ||
    ![null, "identity"].includes(response.headers.get("content-encoding"))
  ) {
    await response.body?.cancel();
    throw new Error("Release discovery unavailable");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    boundedSignal.throwIfAborted();
    length += chunk.byteLength;
    assert(length <= 2 * 1024 * 1024, "Release index exceeds limit");
    chunks.push(Buffer.from(chunk));
  }
  boundedSignal.throwIfAborted();
  const releases = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert(Array.isArray(releases) && releases.length <= 100, "Invalid release index");
  const candidates = [];
  for (const release of releases) {
    if (!release || release.draft !== false || typeof release.tag_name !== "string") continue;
    const version = release.tag_name.slice(1);
    if (!release.tag_name.startsWith("v")) continue;
    try {
      if (compareVersions(version, source.currentVersion) <= 0) continue;
    } catch {
      continue;
    }
    // Channels are distinct in manifest v1; beta does not silently switch to stable.
    if ((source.channel === "beta") !== version.includes("-beta.")) continue;
    candidates.push({ release, version });
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates.length) return { state: "UpToDate" };
  const selected = candidates[0];
  assert(
    candidates.filter((item) => item.version === selected.version).length === 1,
    "Ambiguous release version",
  );
  const assets = selected.release.assets;
  assert(Array.isArray(assets), "Release assets missing");
  const address = (name) => {
    const found = assets.filter((item) => item?.name === name);
    assert.equal(found.length, 1, `Release asset missing or duplicated: ${name}`);
    const expected = `https://github.com/Kubonsang/HoneyBee/releases/download/v${selected.version}/${name}`;
    assert.equal(found[0].browser_download_url, expected, "Release asset identity mismatch");
    return expected;
  };
  const manifestUrl = address("release.json");
  const signatureUrl = address("release.sig.json");
  const authenticated = await fetchAuthenticatedRelease({
    manifestUrl,
    signatureUrl,
    source,
    trustedPublicKeys,
    signal: boundedSignal,
    fetchImpl,
  });
  assert.equal(authenticated.manifest.version, selected.version, "Signed release/tag mismatch");
  return { state: "Available", manifestUrl, signatureUrl, ...authenticated };
};
