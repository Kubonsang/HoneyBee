import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "..", "..");
const outputDirectory = process.env.HONEYBEE_CLI_PACKAGE_DIR ?? "release";
if (path.basename(outputDirectory) !== outputDirectory || outputDirectory === ".") {
  throw new Error("Packaging output must be one directory inside the CLI app.");
}
const outputRoot = path.join(appRoot, outputDirectory);
const bundleRoot = path.join(outputRoot, "HoneyBee-cli-win32-x64");
const bundledTools = path.join(repositoryRoot, "apps", "desktop", ".tools", "win32-x64");
const coreRoot = path.join(repositoryRoot, "packages", "core");
const bundledCore = path.join(bundleRoot, "node_modules", "@honeybee", "core");

await Promise.all([
  access(path.join(appRoot, "dist", "cli.js")),
  access(path.join(coreRoot, "dist", "index.js")),
  access(path.join(bundledTools, "unity-workspace-storage.exe")),
  access(path.join(bundledTools, "honeybee-workspace-storage-host.exe")),
  access(path.join(bundledTools, "manifest.json")),
]);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(bundledCore, { recursive: true });
await cp(path.join(appRoot, "dist"), path.join(bundleRoot, "dist"), { recursive: true });
await Promise.all([
  cp(path.join(appRoot, "package.json"), path.join(bundleRoot, "package.json")),
  cp(path.join(coreRoot, "dist"), path.join(bundledCore, "dist"), { recursive: true }),
  cp(path.join(coreRoot, "package.json"), path.join(bundledCore, "package.json")),
  cp(
    path.join(bundledTools, "unity-workspace-storage.exe"),
    path.join(bundleRoot, "dist", "unity-workspace-storage.exe"),
  ),
  cp(
    path.join(bundledTools, "honeybee-workspace-storage-host.exe"),
    path.join(bundleRoot, "dist", "honeybee-workspace-storage-host.exe"),
  ),
  cp(path.join(bundledTools, "manifest.json"), path.join(bundleRoot, "dist", "manifest.json")),
  cp(path.join(repositoryRoot, "LICENSE"), path.join(bundleRoot, "LICENSE")),
  cp(
    path.join(repositoryRoot, "docs", "operations", "windows-cli-beta.md"),
    path.join(bundleRoot, "README.md"),
  ),
]);
await writeFile(
  path.join(bundleRoot, "honeybee.cmd"),
  [
    "@echo off",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo HoneyBee requires Node.js 24 or newer. 1>&2",
    "  exit /b 1",
    ")",
    "node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)\"",
    "if errorlevel 1 (",
    "  echo HoneyBee requires Node.js 24 or newer. 1>&2",
    "  exit /b 1",
    ")",
    'node "%~dp0dist\\cli.js" %*',
    "",
  ].join("\r\n"),
  "utf8",
);

const cliPackage = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
const result = await execFileAsync("cmd.exe", ["/d", "/c", ".\\honeybee.cmd --version"], {
  cwd: bundleRoot,
  timeout: 30_000,
  windowsHide: true,
});
if (result.stdout.trim() !== cliPackage.version) {
  throw new Error(`Packaged CLI version mismatch: ${result.stdout.trim()}`);
}
process.stdout.write(`${bundleRoot}\n`);
