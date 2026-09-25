import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { inventory, digest, git } from "./release-verification.mjs";

assert.equal(process.platform, "win32", "Compile native QA tools in Windows CI");
const root = path.resolve(import.meta.dirname, "../..");
const destination = path.resolve(process.argv[2] ?? "artifacts/quality/native-tests");
await mkdir(destination, { recursive: true });
const definitions = [
  {
    name: "workspace",
    cwd: "external/storage",
    package: "./workspace",
    module: "github.com/Kubonsang/unity-workspace-storage/workspace",
    tests: ["TestExternalBeeNativeLifecycle", "TestInstalledUserCanWriteMountedParent"],
  },
  {
    name: "storage",
    cwd: "external/storage",
    package: "./storage",
    module: "github.com/Kubonsang/unity-workspace-storage/storage",
    tests: [
      "TestDifferencingChildGeometry",
      "TestDifferencingParentLongPath",
      "TestParentPathSpellings",
    ],
  },
  {
    name: "geometry",
    cwd: "tools/workspace-storage-host",
    package: "./cmd/honeybee-vhdx-bench",
    module: "github.com/Kubonsang/HoneyBee/tools/workspace-storage-host/cmd/honeybee-vhdx-bench",
    tests: ["TestNativeChildGeometry"],
  },
];
const files = [];
for (const definition of definitions) {
  const file = path.join(destination, `${definition.name}.test.exe`);
  execFileSync("go", ["test", "-c", "-tags", "vhdx_integration", "-o", file, definition.package], {
    cwd: path.join(root, definition.cwd),
    stdio: "inherit",
    windowsHide: true,
  });
  files.push({
    file: path.basename(file),
    sha256: digest(await readFile(file)),
    package: definition.module,
    tests: definition.tests,
  });
}
const source = await inventory(root);
await writeFile(
  path.join(destination, "manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      qualificationOnly: true,
      source: { commit: git(root, ["rev-parse", "HEAD"]), inventorySha256: source.sha256 },
      files,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
