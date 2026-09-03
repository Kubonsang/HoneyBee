import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedExecutable =
  process.argv[2] === undefined ? undefined : path.resolve(appRoot, process.argv[2]);
if (packagedExecutable !== undefined) {
  const outputDirectory = process.env.HONEYBEE_DESKTOP_PACKAGE_DIR ?? "release";
  if (path.basename(outputDirectory) !== outputDirectory || outputDirectory === ".") {
    throw new Error("Packaged smoke output must be one directory inside the Desktop app.");
  }
  const releaseRoot = path.join(appRoot, outputDirectory);
  const relative = path.relative(releaseRoot, packagedExecutable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Packaged smoke executable escaped the Desktop release directory.");
  }
  await access(path.join(path.dirname(packagedExecutable), "resources", "honeybee.png"));
}
const userData = await mkdtemp(path.join(tmpdir(), "honeybee-desktop-smoke-"));
const resultPath = path.join(userData, "smoke-result.json");
const child = spawn(
  packagedExecutable ?? electronExecutable,
  [
    "--user-data-dir=" + userData,
    "--disable-gpu",
    "--disable-gpu-sandbox",
    "--disable-software-rasterizer",
    "--no-sandbox",
    "--enable-logging=stderr",
    ...(packagedExecutable === undefined ? [appRoot] : []),
  ],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      HONEYBEE_DESKTOP_SMOKE: "desktop-smoke-v2",
      HONEYBEE_DESKTOP_SMOKE_RESULT: resultPath,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let diagnosticOutput = "";
const collectDiagnostic = (chunk) => {
  diagnosticOutput = (diagnosticOutput + chunk.toString("utf8")).slice(-8192);
};
child.stdout.on("data", collectDiagnostic);
child.stderr.on("data", collectDiagnostic);

let result;
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    result = await readFile(resultPath, "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => undefined);
    if (result?.stage === "passed" || result?.stage === "failed") break;
    if (child.exitCode !== null && result === undefined) break;
    await delay(100);
  }
  if (result?.stage !== "passed") {
    const diagnostic = diagnosticOutput.trim();
    throw new Error(
      "Desktop smoke failed at " +
        (result?.stage ?? "process-start") +
        "." +
        (diagnostic.length === 0 ? "" : "\n" + diagnostic),
    );
  }
  process.stdout.write("Desktop IPC/UI smoke passed.\n");
} finally {
  if (child.pid !== undefined) {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(
        () => undefined,
      );
    } else if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  await rm(userData, { recursive: true, force: true });
}
