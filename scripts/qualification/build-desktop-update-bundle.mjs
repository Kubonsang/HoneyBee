import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
const repo = path.resolve(import.meta.dirname, "../..");
const source = path.resolve(process.argv[2]);
const candidate = JSON.parse(
  await readFile(path.join(repo, "output/two-version-qa/candidate.json")),
);
const target = path.resolve(candidate.installation);
for (const root of [source, target])
  assert(root.startsWith(path.join(repo, "output/two-version-qa") + path.sep));
const sourcePointer = JSON.parse(await readFile(path.join(source, "current.json")));
assert.equal(sourcePointer.activeVersion, "0.1.0-beta.12");
assert.equal(candidate.version, "0.1.0-beta.13");
const base = path.join(repo, "output/vm-qualification");
const bundle = await mkdtemp(path.join(base, "desktop-update-"));
const copy = async (from, relative) => {
  await mkdir(path.dirname(path.join(bundle, relative)), { recursive: true });
  await cp(from, path.join(bundle, relative), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
};
for (const name of ["versions", "current.json", "HoneyBeeLauncher.exe"])
  await copy(path.join(source, name), "source/" + name);
for (const name of [
  "scripts/update",
  "scripts/qualification",
  "packages/core/dist",
  "packages/core/package.json",
  "output/update-tools",
])
  await copy(path.join(repo, name), name);
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
};
const inventory = {};
const walk = async (relative = "") => {
  for (const item of await readdir(path.join(bundle, "source", relative), {
    withFileTypes: true,
  })) {
    const name = relative ? relative + "/" + item.name : item.name;
    assert(!item.isSymbolicLink());
    if (item.isDirectory()) await walk(name);
    else inventory[name] = await hash(path.join(bundle, "source", name));
  }
};
await walk();
await writeFile(path.join(bundle, "inventory.json"), JSON.stringify(inventory, null, 2));
await promisify(execFile)(
  path.join(repo, "output/update-tools/honeybee-update-package.exe"),
  ["pack", path.join(target, "versions", candidate.version), path.join(bundle, "application.zip")],
  { windowsHide: true, timeout: 600000 },
);
const old = JSON.parse(
  await readFile(path.join(base, "two-version-20260911-230149/qualification.json")),
);
const manifest = JSON.parse(
  await readFile(path.join(base, "two-version-20260911-230149/release.json")),
);
manifest.version = candidate.version;
manifest.minimumSourceVersion = sourcePointer.activeVersion;
for (const name of ["desktop", "cli"]) manifest.components[name].version = candidate.version;
manifest.packages.application.url = `https://github.com/Kubonsang/HoneyBee/releases/download/v${candidate.version}/HoneyBee-update-win32-x64.zip`;
manifest.packages.application.sha256 = await hash(path.join(bundle, "application.zip"));
manifest.packages.application.size = (await stat(path.join(bundle, "application.zip"))).size;
await writeFile(path.join(bundle, "release.json"), JSON.stringify(manifest));
const pin = {
  ...old,
  desktopLifecycle: true,
  version: sourcePointer.activeVersion,
  targetVersion: candidate.version,
  launchSha256: sourcePointer.manifestSha256,
  launcherSha256: inventory["HoneyBeeLauncher.exe"],
  nodeSha256: inventory[`versions/${sourcePointer.activeVersion}/runtime/node.exe`],
  inventorySha256: await hash(path.join(bundle, "inventory.json")),
  helperSha256: await hash(path.join(bundle, "output/update-tools/honeybee-update-package.exe")),
  targetManifestSha256: await hash(path.join(bundle, "release.json")),
  targetZipSha256: manifest.packages.application.sha256,
};
await writeFile(path.join(bundle, "qualification.json"), JSON.stringify(pin, null, 2));
await writeFile(
  path.join(bundle, "HoneyBee-Desktop-Update-QA.cmd"),
  '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\qualification\\guest-two-version.ps1"\r\n',
);
await writeFile(path.join(base, "desktop-update-bundle-path.txt"), bundle);
process.stdout.write(bundle + "\n");
