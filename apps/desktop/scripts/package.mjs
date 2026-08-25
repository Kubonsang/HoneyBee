import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(appRoot, "dist", "package");
const output = path.join(appRoot, "release");
const bundledTools = path.join(appRoot, ".tools", "win32-x64");

const assertOwned = (target, parent) => {
  const relative = path.relative(parent, target);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Packaging target escaped the Desktop directory.");
  }
};

assertOwned(staging, appRoot);
assertOwned(output, appRoot);
await rm(staging, { recursive: true, force: true });
await rm(output, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await access(path.join(bundledTools, "unity-workspace-storage.exe"));
await access(path.join(bundledTools, "honeybee-workspace-storage-host.exe"));

for (const directory of ["main", "preload", "renderer"]) {
  await cp(path.join(appRoot, "dist", directory), path.join(staging, directory), {
    recursive: true,
  });
}

const desktopPackage = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
const electronVersion = String(desktopPackage.devDependencies.electron).replace(/^[^\d]*/u, "");
await writeFile(
  path.join(staging, "package.json"),
  JSON.stringify(
    {
      name: "honeybee-desktop",
      productName: "HoneyBee",
      version: desktopPackage.version,
      private: true,
      type: "module",
      main: "main/main/main.js",
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

const paths = await packager({
  dir: staging,
  name: "HoneyBee",
  platform: "win32",
  arch: "x64",
  electronVersion,
  out: output,
  overwrite: true,
  asar: true,
  extraResource: [bundledTools],
  appCopyright: "Copyright HoneyBee contributors",
  win32metadata: {
    CompanyName: "HoneyBee",
    FileDescription: "HoneyBee Unity control plane",
    InternalName: "HoneyBee",
    OriginalFilename: "HoneyBee.exe",
    ProductName: "HoneyBee",
  },
});

if (paths.length !== 1) throw new Error("Expected exactly one packaged Desktop path.");
process.stdout.write(paths[0] + "\n");
