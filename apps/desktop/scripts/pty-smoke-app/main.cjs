const { createRequire } = require("node:module");
const path = require("node:path");

const { app } = require("electron");

const modulePath = process.argv.find(
  (value) => value.includes("app.asar") && value.endsWith("node-pty"),
);
if (modulePath === undefined || !path.isAbsolute(modulePath)) {
  throw new Error("PTY smoke requires one absolute packaged node-pty path.");
}

const localRequire = createRequire(__filename);
void app.whenReady().then(() => {
  const nodePty = localRequire(modulePath);
  const shell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const terminal = nodePty.spawn(
    shell,
    ["-NoLogo", "-NoProfile", "-Command", "Write-Output HONEYBEE_PACKAGED_PTY_OK"],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== undefined),
      ),
      useConpty: true,
    },
  );
  let output = "";
  const timeout = setTimeout(() => {
    terminal.kill();
    process.stderr.write("Packaged PTY smoke timed out.\n");
    app.exit(1);
  }, 10_000);
  terminal.onData((value) => {
    output += value;
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    if (exitCode !== 0 || !output.includes("HONEYBEE_PACKAGED_PTY_OK")) {
      process.stderr.write(`Packaged PTY smoke failed (${exitCode}).\n${output}\n`);
      app.exit(1);
      return;
    }
    process.stdout.write("Packaged interactive PTY smoke passed.\n");
    app.exit(0);
  });
});
