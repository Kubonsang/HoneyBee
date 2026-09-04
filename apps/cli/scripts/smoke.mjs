import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = process.env.HONEYBEE_CLI_PACKAGE_DIR ?? "release";
if (path.basename(outputDirectory) !== outputDirectory || outputDirectory === ".") {
  throw new Error("Packaging output must be one directory inside the CLI app.");
}
const bundleRoot = path.join(appRoot, outputDirectory, "HoneyBee-cli-win32-x64");
const cli = path.join(bundleRoot, "dist", "cli.js");
await Promise.all([
  access(path.join(bundleRoot, "honeybee.cmd")),
  access(path.join(bundleRoot, "LICENSE")),
  access(path.join(bundleRoot, "dist", "unity-workspace-storage.exe")),
  access(path.join(bundleRoot, "dist", "honeybee-workspace-storage-host.exe")),
  access(path.join(bundleRoot, "dist", "manifest.json")),
  access(path.join(bundleRoot, "README.md")),
]);

const assertOnlyJavaScript = async (directory, expected) => {
  const actual = (await readdir(directory)).filter((entry) => entry.endsWith(".js")).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Package contains unexpected JavaScript in ${directory}: ${actual.join(", ")}`);
  }
};
await Promise.all([
  assertOnlyJavaScript(path.join(bundleRoot, "dist"), [
    "cli.js",
    "human-output.js",
    "workspace-command.js",
  ]),
  assertOnlyJavaScript(path.join(bundleRoot, "node_modules", "@honeybee", "core", "dist"), [
    "index.js",
    "workspace-core.js",
    "workspace-doctor.js",
    "workspace-registry.js",
    "workspace-storage.js",
    "workspace-types.js",
  ]),
]);

const dataRoot = await mkdtemp(path.join(tmpdir(), "honeybee-cli-package-smoke-"));
try {
  const version = await execFileAsync("cmd.exe", ["/d", "/c", ".\\honeybee.cmd --version"], {
    cwd: bundleRoot,
    timeout: 30_000,
    windowsHide: true,
  });
  if (version.stdout.trim() !== "0.1.0-beta.4") {
    throw new Error(`Unexpected packaged CLI version: ${version.stdout.trim()}`);
  }
  const listed = await execFileAsync(
    process.execPath,
    [cli, "project", "list", "--data-root", dataRoot, "--json"],
    { cwd: bundleRoot, timeout: 30_000, windowsHide: true },
  );
  const payload = JSON.parse(listed.stdout);
  if (payload.schemaVersion !== 1 || payload.ok !== true || payload.projects?.length !== 0) {
    throw new Error("Packaged CLI returned an invalid project list response.");
  }
  const doctor = await execFileAsync(
    process.execPath,
    [cli, "doctor", "--data-root", dataRoot, "--json"],
    { cwd: bundleRoot, timeout: 30_000, windowsHide: true },
  ).catch((error) => error);
  const doctorOutput = typeof doctor?.stdout === "string" ? JSON.parse(doctor.stdout) : undefined;
  if (
    doctorOutput?.schemaVersion !== 1 ||
    doctorOutput?.ok !== true ||
    typeof doctorOutput?.ready !== "boolean" ||
    !Array.isArray(doctorOutput?.checks)
  ) {
    throw new Error("Packaged CLI returned an invalid doctor response.");
  }
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
process.stdout.write("Packaged HoneyBee CLI smoke passed.\n");
