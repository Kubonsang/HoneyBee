import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readBounded } from "../update/prepare-release.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { parseReleaseManifest, compareVersions, sha256 } from "../update/release-manifest.mjs";
import { recoveryInventoryBytes, verifyRecoverySourceFiles } from "../update/recovery-source.mjs";

const hashFile = async (file) => {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), "Ordinary package file required");
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(file)) {
    hash.update(bytes);
    size += bytes.length;
  }
  assert.equal(size, info.size, "File changed while hashing");
  return { size, sha256: hash.digest("hex") };
};

/** Produce reviewable manifest/package bytes. Signing is a separate explicit
 * operation with the existing protected key; this does not publish or qualify. */
export async function buildUpdateMedia({
  installationRoot,
  outputRoot,
  minimumSourceVersion,
  minimumBootstrapperVersion,
  channel,
  mandatory = false,
  migration,
}) {
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  const pointer = JSON.parse(await readBounded(path.join(root, "current.json")));
  assert.equal(pointer.schemaVersion, 1);
  compareVersions(pointer.activeVersion, "0.0.0");
  const release = path.join(root, "versions", pointer.activeVersion);
  await plainDirectory(release);
  assert.equal(
    sha256(await readBounded(path.join(release, "launch.json"))),
    pointer.manifestSha256,
  );
  const metadata = JSON.parse(await readBounded(path.join(release, "installation.json")));
  const files = {};
  const walk = async (relative = "") => {
    for (const item of await readdir(path.join(release, relative), { withFileTypes: true })) {
      assert(!item.isSymbolicLink(), "Redirected release payload");
      const name = relative ? relative + "/" + item.name : item.name;
      if (item.isDirectory()) {
        await plainDirectory(path.join(release, name));
        await walk(name);
      } else files[name] = await hashFile(path.join(release, name));
    }
  };
  await walk();
  const inventory = recoveryInventoryBytes(files);
  const approved = {
    version: pointer.activeVersion,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value.sha256])),
  };
  await verifyRecoverySourceFiles(root, approved);
  await mkdir(outputRoot, { recursive: true });
  await plainDirectory(outputRoot);
  const directory = await mkdtemp(path.join(path.resolve(outputRoot), "media-"));
  const archive = path.join(directory, "application.zip");
  const helper = path.resolve(
    import.meta.dirname,
    "../../output/update-tools/honeybee-update-package.exe",
  );
  await promisify(execFile)(helper, ["pack", release, archive], {
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 65536,
  });
  await verifyRecoverySourceFiles(root, approved);
  const manifest = {
    schemaVersion: 1,
    version: pointer.activeVersion,
    channel,
    mandatory,
    minimumSourceVersion,
    minimumBootstrapperVersion,
    packages: {
      application: {
        url: `https://github.com/Kubonsang/HoneyBee/releases/download/v${pointer.activeVersion}/application.zip`,
        ...(await hashFile(archive)),
        format: "zip",
      },
    },
    components: {
      desktop: { version: pointer.activeVersion, package: "application" },
      cli: { version: pointer.activeVersion, package: "application" },
      storage: {
        componentVersion: metadata.componentVersion,
        package: "application",
        migration: migration ?? {
          kind: "none",
          supportedSourceVersions: [metadata.componentVersion],
        },
      },
    },
    recovery: {
      schemaVersion: 1,
      inventorySha256: sha256(inventory),
      launchManifestSha256: pointer.manifestSha256,
    },
  };
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  parseReleaseManifest(Buffer.from(bytes), sha256(bytes));
  await writeFile(path.join(directory, "inventory.json"), inventory, { flag: "wx" });
  await writeFile(path.join(directory, "release.json"), bytes, { flag: "wx" });
  return {
    schemaVersion: 1,
    directory,
    version: pointer.activeVersion,
    manifestSha256: sha256(bytes),
    packageSha256: manifest.packages.application.sha256,
    signed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert(process.argv.length === 3, "Usage: build-update-media.mjs <build-config.json>");
  process.stdout.write(
    JSON.stringify(
      await buildUpdateMedia(JSON.parse(await readBounded(process.argv[2]))),
      null,
      2,
    ) + "\n",
  );
}
