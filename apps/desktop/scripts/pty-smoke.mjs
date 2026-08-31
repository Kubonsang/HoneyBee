import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedExecutable = path.resolve(appRoot, process.argv[2] ?? "");
const outputDirectory = process.env.HONEYBEE_DESKTOP_PACKAGE_DIR ?? "release";
const releaseRoot = path.join(appRoot, outputDirectory);
const relative = path.relative(releaseRoot, packagedExecutable);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("Packaged PTY smoke executable escaped the Desktop release directory.");
}

const modulePath = path.join(
  path.dirname(packagedExecutable),
  "resources",
  "app.asar",
  "node_modules",
  "node-pty",
);
const smokeApp = path.join(appRoot, "scripts", "pty-smoke-app");
const child = spawn(electronExecutable, [smokeApp, modulePath], {
  cwd: appRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  });
}
const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Packaged PTY smoke exceeded 20 seconds.")),
    20_000,
  );
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
}).catch(async (error) => {
  if (child.pid !== undefined) {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => undefined);
  }
  throw error;
});
if (exitCode !== 0 || !output.includes("Packaged interactive PTY smoke passed.")) {
  throw new Error(`Packaged interactive PTY smoke failed (${exitCode}).\n${output}`);
}
process.stdout.write("Packaged interactive PTY smoke passed.\n");
