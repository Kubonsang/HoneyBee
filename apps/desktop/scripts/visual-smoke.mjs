import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(appRoot, ".qa", "desktop-beta3"));
const viewport = /^(\d+)x(\d+)$/u.exec(process.argv[3] ?? "1280x820");
if (viewport === null) throw new Error("Viewport must use WIDTHxHEIGHT.");
const userData = await mkdtemp(path.join(tmpdir(), "honeybee-desktop-visual-"));
const child = spawn(
  electron,
  [
    `--user-data-dir=${userData}`,
    "--disable-gpu",
    "--disable-gpu-sandbox",
    "--no-sandbox",
    appRoot,
  ],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      HONEYBEE_DESKTOP_CAPTURE_DIR: output,
      HONEYBEE_DESKTOP_CAPTURE_WIDTH: viewport[1],
      HONEYBEE_DESKTOP_CAPTURE_HEIGHT: viewport[2],
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnostics = "";
const collect = (chunk) => {
  diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8192);
};
child.stdout.on("data", collect);
child.stderr.on("data", collect);
const exitCode = await new Promise((resolve) => {
  const timeout = setTimeout(() => {
    child.kill();
    resolve(-1);
  }, 30_000);
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code ?? -1);
  });
});
if (exitCode !== 0) throw new Error(`Desktop visual smoke failed (${exitCode}).\n${diagnostics}`);
for (const name of [
  "01-workbench.png",
  "02-create-dialog.png",
  "03-project-picker.png",
  "04-project-setup.png",
  "05-project-home.png",
  "06-language-toggle.png",
])
  await access(path.join(output, name));
process.stdout.write(`Desktop visual fixture passed: ${output}\n`);
await rm(userData, { recursive: true, force: true });
