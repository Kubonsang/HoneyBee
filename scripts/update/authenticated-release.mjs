import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import path from "node:path";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { admitRelease, validateDownloadUrl } from "./release-manifest.mjs";
import { downloadResponse, stageRelease } from "./stage-release.mjs";

const readMetadata = async (url, limit, signal, fetchImpl) => {
  const response = await downloadResponse(url, signal, fetchImpl);
  const chunks = [];
  let length = 0;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    await response.body.cancel();
    throw new Error("Release metadata Content-Length rejected");
  }
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    length += chunk.byteLength;
    assert(length <= limit, "Release metadata exceeds limit");
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  if (declared !== null) assert.equal(length, Number(declared), "Incomplete release metadata");
  return Buffer.concat(chunks);
};

/** Read-only metadata admission. An unsigned release cannot trigger package download. */
export const fetchAuthenticatedRelease = async ({
  manifestUrl,
  signatureUrl,
  trustedPublicKeys,
  source,
  signal,
  fetchImpl = globalThis.fetch,
}) => {
  source = { ...source };
  trustedPublicKeys = [...trustedPublicKeys];
  const manifestAddress = validateDownloadUrl(manifestUrl);
  const signatureAddress = validateDownloadUrl(signatureUrl);
  assert.equal(
    new globalThis.URL(".", manifestAddress).href,
    new globalThis.URL(".", signatureAddress).href,
    "Release metadata must share a release directory",
  );
  assert.notEqual(manifestAddress.href, signatureAddress.href);
  const timeout = globalThis.AbortSignal.timeout(30000);
  const boundedSignal = signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
  const bytes = await readMetadata(manifestAddress.href, 64 * 1024, boundedSignal, fetchImpl);
  const signature = await readMetadata(signatureAddress.href, 4096, boundedSignal, fetchImpl);
  const authenticated = authenticateReleaseManifest(bytes, signature, trustedPublicKeys);
  admitRelease(authenticated.manifest, source);
  return authenticated;
};

/** Public-facing composition; existing digest-only staging remains an internal primitive. */
export const stageAuthenticatedRelease = async (options) => {
  options = { ...options, source: { ...options.source } };
  const authenticated = await fetchAuthenticatedRelease(options);
  if (options.expectedManifestSha256 !== undefined)
    assert.equal(
      authenticated.manifestSha256,
      options.expectedManifestSha256,
      "Offered release changed; check for updates again",
    );
  const staged = await stageRelease({
    installationRoot: options.installationRoot,
    source: options.source,
    manifestBytes: authenticated.manifestBytes,
    manifestSha256: authenticated.manifestSha256,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
  });
  // Preserve the actual signature, not just the identity reported by this process.
  // Later preparation must authenticate it again against its own trusted keys.
  const proof = await open(path.join(staged.attempt, "release.sig.json"), "wx");
  try {
    await proof.writeFile(authenticated.signatureBytes);
    await proof.sync();
  } finally {
    await proof.close();
  }
  return {
    ...staged,
    signerKeyId: authenticated.signerKeyId,
    manifestSha256: authenticated.manifestSha256,
  };
};
