import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { authenticateReleaseManifest, signReleaseManifest } from "./release-authentication.mjs";
import { fetchAuthenticatedRelease, stageAuthenticatedRelease } from "./authenticated-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { discoverRelease, releaseIndexUrl } from "./release-discovery.mjs";

const keys = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const releaseRoot = "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.12/";
const payload = Buffer.from("signed fixture package, never executed");
const source = {
  currentVersion: "0.1.0-beta.11",
  bootstrapperVersion: "1.0.0",
  channel: "beta",
  storageComponentVersion: "test.hb12",
};
const manifest = () => ({
  schemaVersion: 1,
  version: "0.1.0-beta.12",
  channel: "beta",
  mandatory: false,
  minimumSourceVersion: source.currentVersion,
  minimumBootstrapperVersion: "1.0.0",
  packages: {
    application: {
      url: releaseRoot + "application.zip",
      sha256: sha256(payload),
      size: payload.length,
      format: "zip",
    },
  },
  components: {
    desktop: { version: "0.1.0-beta.12", package: "application" },
    cli: { version: "0.1.0-beta.12", package: "application" },
    storage: {
      componentVersion: "test.hb12",
      package: "application",
      migration: { kind: "none", supportedSourceVersions: ["test.hb12"] },
    },
  },
});
const fixture = () => {
  const bytes = Buffer.from(JSON.stringify(manifest()));
  return { bytes, signature: signReleaseManifest(bytes, keys.privateKey) };
};
test("a trusted Ed25519 signature authenticates exact manifest bytes", () => {
  const { bytes, signature } = fixture();
  const result = authenticateReleaseManifest(bytes, signature, [other.publicKey, keys.publicKey]);
  assert.deepEqual(result.manifest, manifest());
  assert.equal(result.manifestSha256, sha256(bytes));
  bytes.fill(0);
  assert.equal(result.manifestBytes[0], 123, "Verifier must own its byte snapshot");
});
for (const damage of [
  "bytes",
  "resigned-digest",
  "unknown-key",
  "algorithm",
  "encoding",
  "extra-key",
  "context",
  "oversize",
]) {
  test(`signature refusal: ${damage}`, () => {
    let { bytes, signature } = fixture();
    const envelope = JSON.parse(signature);
    if (damage === "bytes" || damage === "resigned-digest")
      bytes = Buffer.from(bytes.toString().replace('"mandatory":false', '"mandatory":true'));
    if (damage === "resigned-digest") envelope.manifestSha256 = sha256(bytes);
    if (damage === "unknown-key") signature = signReleaseManifest(bytes, other.privateKey);
    else {
      if (damage === "algorithm") envelope.algorithm = "rsa";
      if (damage === "encoding") envelope.signature = envelope.signature.slice(0, -1) + " ";
      if (damage === "extra-key")
        envelope.publicKey = other.publicKey.export({ type: "spki", format: "pem" });
      if (damage === "context")
        envelope.signature = sign(null, bytes, keys.privateKey).toString("base64");
      signature = Buffer.from(JSON.stringify(envelope));
    }
    if (damage === "oversize") signature = Buffer.alloc(4097);
    assert.throws(() => authenticateReleaseManifest(bytes, signature, [keys.publicKey]));
  });
}
test("no implicit trust, wrong key types and duplicate trust keys fail", () => {
  const { bytes, signature } = fixture();
  for (const trusted of [
    [],
    [keys.publicKey, keys.publicKey],
    [generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey],
  ])
    assert.throws(() => authenticateReleaseManifest(bytes, signature, trusted));
});

async function downloadFixture() {
  const base = path.resolve("output/authenticated-release-tests");
  await mkdir(base, { recursive: true });
  const installationRoot = await mkdtemp(path.join(base, "case-"));
  await writeFile(path.join(installationRoot, "current.json"), "known-good");
  const { bytes, signature } = fixture();
  const calls = [];
  const assets = new Map([
    [releaseRoot + "release.json", bytes],
    [releaseRoot + "release.sig.json", signature],
    [releaseRoot + "application.zip", payload],
  ]);
  return {
    installationRoot,
    source,
    manifestUrl: releaseRoot + "release.json",
    signatureUrl: releaseRoot + "release.sig.json",
    trustedPublicKeys: [keys.publicKey],
    calls,
    assets,
    fetchImpl: async (url) => {
      calls.push(url);
      assert(assets.has(url), "Unexpected network destination");
      return new globalThis.Response(assets.get(url));
    },
  };
}

const releaseEntry = (version = "0.1.0-beta.12") => ({
  tag_name: "v" + version,
  draft: false,
  assets: ["release.json", "release.sig.json"].map((name) => ({
    name,
    browser_download_url: `https://github.com/Kubonsang/HoneyBee/releases/download/v${version}/${name}`,
  })),
});
test("GitHub discovery authenticates metadata without downloading an application", async () => {
  const options = await downloadFixture();
  options.assets.set(releaseIndexUrl, JSON.stringify([releaseEntry()]));
  const result = await discoverRelease(options);
  assert.equal(result.state, "Available");
  assert.equal(result.manifest.version, "0.1.0-beta.12");
  assert.deepEqual(options.calls, [releaseIndexUrl, options.manifestUrl, options.signatureUrl]);
});
test("drafts, other channels, invalid tags and installed versions are not offered", async () => {
  const options = await downloadFixture();
  options.assets.set(
    releaseIndexUrl,
    JSON.stringify([
      { ...releaseEntry(), draft: true },
      releaseEntry("0.1.0"),
      releaseEntry("0.1.0-beta.11"),
      releaseEntry("garbage"),
    ]),
  );
  assert.deepEqual(await discoverRelease(options), { state: "UpToDate" });
  assert.deepEqual(options.calls, [releaseIndexUrl]);
});
for (const failure of [
  "missing-signature",
  "duplicate-asset",
  "foreign-asset",
  "duplicate-version",
  "invalid-signature",
  "wrong-tag",
  "oversized-index",
]) {
  test(`discovery fails closed for ${failure}`, async () => {
    const options = await downloadFixture();
    const release = releaseEntry();
    if (failure === "missing-signature") release.assets.pop();
    if (failure === "duplicate-asset") release.assets.push(release.assets[0]);
    if (failure === "foreign-asset")
      release.assets[0].browser_download_url = "https://example.com/release.json";
    if (failure === "invalid-signature") options.assets.set(options.signatureUrl, "{}");
    const entries = [release];
    if (failure === "duplicate-version") entries.push(release);
    if (failure === "wrong-tag") {
      entries.unshift(releaseEntry("0.1.0-beta.13"));
      options.assets.set(
        options.manifestUrl.replace("beta.12", "beta.13"),
        options.assets.get(options.manifestUrl),
      );
      options.assets.set(
        options.signatureUrl.replace("beta.12", "beta.13"),
        options.assets.get(options.signatureUrl),
      );
    }
    options.assets.set(
      releaseIndexUrl,
      failure === "oversized-index" ? Buffer.alloc(2 * 1024 * 1024 + 1) : JSON.stringify(entries),
    );
    await assert.rejects(discoverRelease(options));
    assert(!options.calls.some((url) => url.endsWith("application.zip")));
    assert.deepEqual(await readdir(options.installationRoot), ["current.json"]);
  });
}
test("discovery transport failure is an error, not an up-to-date result", async () => {
  const options = await downloadFixture();
  await assert.rejects(
    discoverRelease({
      ...options,
      fetchImpl: async () => new globalThis.Response("rate limited", { status: 403 }),
    }),
    /unavailable/,
  );
  await assert.rejects(discoverRelease({ ...options, signal: globalThis.AbortSignal.abort() }));
  assert.deepEqual(options.calls, []);
});
test("authenticated staging downloads a package only after signed metadata admission", async () => {
  const options = await downloadFixture();
  const result = await stageAuthenticatedRelease(options);
  assert.equal(result.state, "Verified");
  assert.equal(options.calls.length, 3);
  assert.deepEqual(
    await readFile(path.join(result.attempt, "release.sig.json")),
    options.assets.get(options.signatureUrl),
  );
  assert.equal(
    await readFile(path.join(options.installationRoot, "current.json"), "utf8"),
    "known-good",
  );
});

test("a different valid signed offer cannot replace the release selected by the user", async () => {
  const options = await downloadFixture();
  const expectedManifestSha256 = sha256(options.assets.get(options.manifestUrl));
  const changed = Buffer.from(JSON.stringify({ ...manifest(), mandatory: true }));
  options.assets.set(options.manifestUrl, changed);
  options.assets.set(options.signatureUrl, signReleaseManifest(changed, keys.privateKey));
  await assert.rejects(
    stageAuthenticatedRelease({ ...options, expectedManifestSha256 }),
    /Offered release changed/,
  );
  assert(!options.calls.some((url) => url.endsWith("application.zip")));
  assert.deepEqual(await readdir(options.installationRoot), ["current.json"]);
});
for (const failure of [
  "bad-signature",
  "metadata-overflow",
  "not-newer",
  "source-floor",
  "wrong-channel",
  "bootstrapper",
  "storage",
  "cancel",
  "wrong-host",
  "different-release",
]) {
  test(`metadata refusal ${failure} cannot download a package or create update state`, async () => {
    const options = await downloadFixture();
    if (failure === "bad-signature") options.assets.set(options.signatureUrl, Buffer.from("{}"));
    if (failure === "metadata-overflow")
      options.assets.set(options.manifestUrl, Buffer.alloc(65537));
    if (failure === "not-newer") options.source = { ...source, currentVersion: "0.1.0-beta.12" };
    if (failure === "source-floor") options.source = { ...source, currentVersion: "0.1.0-beta.10" };
    if (failure === "wrong-channel") options.source = { ...source, channel: "stable" };
    if (failure === "bootstrapper") options.source = { ...source, bootstrapperVersion: "0.0.1" };
    if (failure === "storage") options.source = { ...source, storageComponentVersion: "old.hb11" };
    if (failure === "cancel") options.signal = globalThis.AbortSignal.abort();
    if (failure === "wrong-host") options.manifestUrl = "https://example.com/release.json";
    if (failure === "different-release")
      options.signatureUrl = options.signatureUrl.replace("beta.12", "beta.13");
    await assert.rejects(fetchAuthenticatedRelease(options));
    await assert.rejects(stageAuthenticatedRelease(options));
    assert(!options.calls.some((url) => url.endsWith("application.zip")));
    assert.deepEqual(await readdir(options.installationRoot), ["current.json"]);
    assert.equal(
      await readFile(path.join(options.installationRoot, "current.json"), "utf8"),
      "known-good",
    );
  });
}
