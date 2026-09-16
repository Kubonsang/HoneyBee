import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inventoryTree } from "./fresh-install.mjs";
import { createEmbeddedReleaseTransport } from "../update/setup-upgrade.mjs";
import { recoveryInventoryBytes } from "../update/recovery-source.mjs";
import { sha256 } from "../update/release-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../..");
const source = process.argv[2];
const mediaDirectory = process.argv[3];
assert(
  source && path.isAbsolute(source),
  "Usage: build-setup.mjs <absolute assembled installation> [absolute signed update media directory]",
);
assert(
  process.argv.length <= 4 && (mediaDirectory === undefined || path.isAbsolute(mediaDirectory)),
);
const inventory = await inventoryTree(source);
const activation = JSON.parse(await readFile(path.join(source, "current.json"), "utf8"));
assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(activation.activeVersion));
const host = path.join(
  source,
  "versions",
  activation.activeVersion,
  "tools/honeybee-workspace-storage-host.exe",
);
const capability = await promisify(execFile)(host, ["install-capabilities"], { windowsHide: true });
assert.equal(
  JSON.parse(capability.stdout).freshInstallElevation,
  1,
  "Setup requires the fresh-install elevation host",
);
const setupCore = await import(
  pathToFileURL(
    path.join(
      source,
      "versions",
      activation.activeVersion,
      "cli/node_modules/@honeybee/core/dist/index.js",
    ),
  ).href
);
assert.equal(
  typeof setupCore.checkGitExecutable,
  "function",
  "Setup requires the shared Git prerequisite check",
);
const output = path.join(repository, "output/setup");
await mkdir(output, { recursive: true });
const build = await mkdtemp(path.join(output, "build-"));
const bundle = path.join(build, "bundle");
await mkdir(bundle);
await cp(source, path.join(bundle, "payload"), { recursive: true });
await cp(path.join(repository, "scripts/update"), path.join(bundle, "scripts/update"), {
  recursive: true,
});
// Update/Repair imports must use the same core bytes as this Setup payload,
// never a separately rebuilt workspace package.
await cp(
  path.join(source, "versions", activation.activeVersion, "cli/node_modules/@honeybee/core"),
  path.join(bundle, "packages/core"),
  { recursive: true },
);
if (mediaDirectory) {
  const trust = JSON.parse(
    await readFile(path.join(source, "recovery/v1/update-trust.json"), "utf8"),
  );
  const media = await createEmbeddedReleaseTransport(mediaDirectory, trust.publicKeys);
  const manifest = media.authenticated.manifest;
  assert.equal(manifest.version, activation.activeVersion, "Setup and signed release differ");
  assert.equal(manifest.recovery?.launchManifestSha256, activation.manifestSha256);
  const files = {};
  const prefix = `versions/${activation.activeVersion}/`;
  for (const [name, digest] of Object.entries(inventory))
    if (name.startsWith(prefix)) {
      files[name.slice(prefix.length)] = {
        size: (await lstat(path.join(source, name))).size,
        sha256: digest,
      };
    }
  assert.equal(
    sha256(recoveryInventoryBytes(files)),
    manifest.recovery.inventorySha256,
    "Setup application differs from signed recovery inventory",
  );
  const destination = path.join(bundle, "update-media");
  await mkdir(destination);
  for (const name of ["release.json", "release.sig.json", "application.zip"])
    await cp(path.join(mediaDirectory, name), path.join(destination, name));
  // Re-authenticate the copied metadata and hash the actual embedded archive.
  const copied = await createEmbeddedReleaseTransport(destination, trust.publicKeys);
  assert.equal(copied.authenticated.manifestSha256, media.authenticated.manifestSha256);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path.join(destination, "application.zip")))
    hash.update(bytes);
  assert.equal(
    hash.digest("hex"),
    manifest.packages.application.sha256,
    "Embedded package changed",
  );
}
await cp(path.join(repository, "output/update-tools"), path.join(bundle, "output/update-tools"), {
  recursive: true,
});
for (const name of [
  "fresh-install.mjs",
  "setup-entry.mjs",
  "service-setup.mjs",
  "component-repair.mjs",
  "adopt-projects.mjs",
])
  await cp(path.join(here, name), path.join(bundle, name));
await writeFile(path.join(bundle, "inventory.json"), JSON.stringify(inventory));
const toolMetadata = JSON.parse(
  await readFile(
    path.join(source, "versions", activation.activeVersion, "tools/manifest.json"),
    "utf8",
  ),
);
const destination = path.join(
  build,
  toolMetadata.qualificationOnly === true
    ? "HoneyBeeSetup-qualification-baseline.exe"
    : "HoneyBeeSetup-preview.exe",
);
const compiler = process.env.HONEYBEE_MAKENSIS ?? "makensis";
await promisify(execFile)(
  compiler,
  [
    "/V2",
    `/DSETUP_OUTPUT=${destination}`,
    `/DSETUP_BUNDLE=${bundle}`,
    `/DAPP_VERSION=${activation.activeVersion}`,
    `/DAPP_VERSION_NUMERIC=${activation.activeVersion.split("-")[0]}.0`,
    path.join(here, "HoneyBeeSetup.nsi"),
  ],
  { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 },
);
process.stdout.write(destination + "\n");
