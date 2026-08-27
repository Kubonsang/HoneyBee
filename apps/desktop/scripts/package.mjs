import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(appRoot, "dist", "package");
const output = path.join(appRoot, "release");
const bundledTools = path.join(appRoot, ".tools", "win32-x64");
const compatibilityManifest = path.join(appRoot, "resources", "component-compatibility-v1.json");
const nativeAgentHostManifest = path.join(appRoot, "resources", "native-agent-host-v1.json");

const assertOwned = (target, parent) => {
  const relative = path.relative(parent, target);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Packaging target escaped the Desktop directory.");
  }
};

assertOwned(staging, appRoot);
assertOwned(output, appRoot);
await access(path.join(bundledTools, "unity-workspace-storage.exe"));
await access(path.join(bundledTools, "honeybee-workspace-storage-host.exe"));
await access(path.join(bundledTools, "honeybee-native-agent-host.exe"));
await access(compatibilityManifest);
await access(nativeAgentHostManifest);
const preparedTools = JSON.parse(await readFile(path.join(bundledTools, "manifest.json"), "utf8"));
const compatibility = JSON.parse(await readFile(compatibilityManifest, "utf8"));
const approvedNativeHost = JSON.parse(await readFile(nativeAgentHostManifest, "utf8"));
const approvedStorage = compatibility.workspaceStorage?.find(
  (release) => release.version === preparedTools.workspaceStorageVersion,
);
if (approvedStorage === undefined) {
  throw new Error("Prepared workspace-storage version is absent from the compatibility manifest.");
}
const preparedNativeHost = preparedTools.files?.[approvedNativeHost.fileName];
if (
  preparedNativeHost === undefined ||
  preparedNativeHost.byteLength !== approvedNativeHost.byteLength ||
  preparedNativeHost.sha256 !== approvedNativeHost.sha256
) {
  throw new Error("Prepared native-agent-host does not match its committed pin.");
}
for (const payload of approvedStorage.payloads) {
  const prepared = preparedTools.files?.[payload.fileName];
  if (
    prepared === undefined ||
    prepared.byteLength !== payload.byteLength ||
    prepared.sha256 !== payload.sha256
  ) {
    throw new Error("Prepared workspace-storage does not match the compatibility manifest.");
  }
}

await rm(staging, { recursive: true, force: true });
await rm(output, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

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
  extraResource: [bundledTools, compatibilityManifest, nativeAgentHostManifest],
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
