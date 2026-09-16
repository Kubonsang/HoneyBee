import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const repo = path.resolve(import.meta.dirname, "../..");
assert(
  process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === "--reboot"),
  "Usage: build-setup-recovery-bundle.mjs <startup QA bundle> <Setup EXE> [--reboot]",
);
const reboot = process.argv[4] === "--reboot";
const previous = path.resolve(process.argv[2]);
const setup = path.resolve(process.argv[3]);
const pin = JSON.parse(await readFile(path.join(previous, "qualification.json")));
assert(pin.startupRecovery && !pin.startupReboot && pin.desktopLifecycle);
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const inventoryBytes = await readFile(path.join(path.dirname(setup), "bundle/inventory.json"));
const setupInventory = JSON.parse(inventoryBytes);
assert(setupInventory["recovery/v1/manifest.json"] === pin.recoveryManifestSha256);
assert(setupInventory["HoneyBeeLauncher.exe"] === pin.launcherSha256);
assert(setupInventory["bin/honeybee.exe"] === pin.shimSha256);
for (const [name, digest] of Object.entries(setupInventory)) {
  assert(
    !name.includes("\\") &&
      !name.includes(":") &&
      name.split("/").every((p) => p && p !== "." && p !== ".."),
  );
  assert.equal(
    await hash(path.join(previous, "source", name)),
    digest,
    `Setup/QA source mismatch: ${name}`,
  );
}
const base = path.join(repo, "output/vm-qualification");
await mkdir(base, { recursive: true });
const bundleName = reboot ? "setup-reboot" : "setup-recovery";
const bundle = await mkdtemp(path.join(base, bundleName + "-"));
const copy = async (source, name) => {
  await mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
  await cp(source, path.join(bundle, name), { recursive: true, force: false, errorOnExist: true });
};
for (const name of [
  "source",
  "application.zip",
  "release.json",
  "inventory.json",
  "packages",
  "output",
])
  await copy(path.join(previous, name), name);
for (const name of ["scripts/qualification", "scripts/update"])
  await copy(path.join(repo, name), name);
await copy(
  path.join(repo, "scripts/installation/fresh-install.mjs"),
  "scripts/installation/fresh-install.mjs",
);
await copy(setup, "HoneyBeeSetup-preview.exe");
await writeFile(path.join(bundle, "setup-inventory.json"), inventoryBytes);
assert.equal(await hash(path.join(bundle, "inventory.json")), pin.inventorySha256);
assert.equal(await hash(path.join(bundle, "application.zip")), pin.targetZipSha256);
assert.equal(await hash(path.join(bundle, "release.json")), pin.targetManifestSha256);
assert.equal(
  await hash(path.join(bundle, "output/update-tools/honeybee-update-package.exe")),
  pin.helperSha256,
);
pin.setupSource = true;
if (reboot) {
  pin.startupReboot = true;
  pin.interruption = true;
}
pin.setupSha256 = await hash(path.join(bundle, "HoneyBeeSetup-preview.exe"));
pin.setupInventorySha256 = await hash(path.join(bundle, "setup-inventory.json"));
await writeFile(path.join(bundle, "qualification.json"), JSON.stringify(pin, null, 2));
await writeFile(
  path.join(bundle, reboot ? "HoneyBee-Setup-Reboot-QA.cmd" : "HoneyBee-Setup-Recovery-QA.cmd"),
  '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\qualification\\guest-two-version.ps1"\r\n',
);
await writeFile(path.join(base, bundleName + "-bundle-path.txt"), bundle);
process.stdout.write(bundle + "\n");
