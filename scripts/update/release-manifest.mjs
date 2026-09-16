import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { URL } from "node:url";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const maxPackageBytes = 4 * 1024 ** 3;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/u;
export const compareVersions = (left, right) => {
  const parse = (value) => {
    assert(
      typeof value === "string" && value.length <= 80 && versionPattern.test(value),
      "Unsupported release version",
    );
    const parts = versionPattern
      .exec(value)
      .slice(1)
      .map((part) => (part === undefined ? Infinity : Number(part)));
    assert(
      parts.every((part) => part === Infinity || Number.isSafeInteger(part)),
      "Version overflow",
    );
    return parts;
  };
  const a = parse(left),
    b = parse(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};
export const validateDownloadUrl = (value, redirect = false) => {
  assert(typeof value === "string" && value.length <= 8192, "Invalid package URL");
  const url = new URL(value);
  assert(
    url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash,
    "Unsafe package URL",
  );
  const release =
    url.hostname === "github.com" &&
    /^\/Kubonsang\/HoneyBee\/releases\/download\/[^/]+\/[^/]+$/u.test(url.pathname) &&
    !url.search;
  assert(
    release || (redirect && url.hostname === "release-assets.githubusercontent.com"),
    "Unapproved package host or repository",
  );
  return url;
};
const fields = (value, keys) => {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected object");
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "Unsupported or missing manifest fields",
  );
};
const identifier = (value) =>
  assert(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(value),
    "Invalid compatibility identifier",
  );

/** A digest pins exact metadata bytes; it is not publisher authentication. */
export const parseReleaseManifest = (bytes, expectedSha256) => {
  assert(bytes.byteLength <= 64 * 1024, "Manifest exceeds 64 KiB");
  assert(
    typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/u.test(expectedSha256),
    "Manifest SHA-256 required",
  );
  assert.equal(sha256(bytes), expectedSha256, "Manifest SHA-256 mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  fields(manifest, [
    "schemaVersion",
    "version",
    "channel",
    "mandatory",
    "minimumSourceVersion",
    "minimumBootstrapperVersion",
    "packages",
    "components",
    ...(Object.hasOwn(manifest, "recovery") ? ["recovery"] : []),
  ]);
  assert.equal(manifest.schemaVersion, 1, "Unsupported manifest schema");
  if (Object.hasOwn(manifest, "recovery")) {
    fields(manifest.recovery, ["schemaVersion", "inventorySha256", "launchManifestSha256"]);
    assert.equal(manifest.recovery.schemaVersion, 1);
    for (const name of ["inventorySha256", "launchManifestSha256"])
      assert(
        typeof manifest.recovery[name] === "string" &&
          /^[a-f0-9]{64}$/u.test(manifest.recovery[name]),
        "Invalid recovery digest",
      );
  }
  compareVersions(manifest.version, manifest.minimumSourceVersion);
  compareVersions(manifest.minimumBootstrapperVersion, "0.0.0");
  assert(
    compareVersions(manifest.version, manifest.minimumSourceVersion) > 0,
    "Invalid source version floor",
  );
  assert(["beta", "stable"].includes(manifest.channel), "Unknown rollout channel");
  assert(
    manifest.channel !== "stable" || !manifest.version.includes("-"),
    "Prerelease on stable channel",
  );
  assert.equal(typeof manifest.mandatory, "boolean");
  fields(manifest.packages, ["application"]);
  const artifact = manifest.packages.application;
  fields(artifact, ["url", "sha256", "size", "format"]);
  validateDownloadUrl(artifact.url);
  assert(/^[a-f0-9]{64}$/u.test(artifact.sha256), "Invalid package SHA-256");
  assert(
    Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= maxPackageBytes,
    "Invalid package size",
  );
  assert.equal(artifact.format, "zip");
  fields(manifest.components, ["desktop", "cli", "storage"]);
  for (const name of ["desktop", "cli"]) {
    fields(manifest.components[name], ["version", "package"]);
    assert.equal(manifest.components[name].version, manifest.version, "Mixed app release");
    assert.equal(manifest.components[name].package, "application");
  }
  const storage = manifest.components.storage;
  fields(storage, ["componentVersion", "package", "migration"]);
  identifier(storage.componentVersion);
  assert.equal(storage.package, "application");
  fields(storage.migration, ["kind", "supportedSourceVersions"]);
  assert(
    ["none", "service-replacement"].includes(storage.migration.kind),
    "Unknown migration requirement",
  );
  const sources = storage.migration.supportedSourceVersions;
  assert(
    Array.isArray(sources) && sources.length > 0 && sources.length <= 32,
    "Invalid storage sources",
  );
  sources.forEach(identifier);
  assert.equal(new Set(sources).size, sources.length, "Duplicate storage sources");
  if (storage.migration.kind === "none")
    assert.deepEqual(
      sources,
      [storage.componentVersion],
      "No-migration requires exact compatibility",
    );
  return manifest;
};

export const admitRelease = (
  manifest,
  { currentVersion, bootstrapperVersion, channel, storageComponentVersion },
) => {
  assert.equal(channel, manifest.channel, "Channel mismatch");
  assert(
    compareVersions(currentVersion, manifest.minimumSourceVersion) >= 0,
    "Source version too old",
  );
  assert(compareVersions(currentVersion, manifest.version) < 0, "Release is not newer");
  assert(
    compareVersions(bootstrapperVersion, manifest.minimumBootstrapperVersion) >= 0,
    "Bootstrapper upgrade required",
  );
  assert(
    manifest.components.storage.migration.supportedSourceVersions.includes(storageComponentVersion),
    "Unsupported storage source",
  );
};
