import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { promisify } from "node:util";
import { verifyAppVersion } from "./app-activation.mjs";
import { packageTool } from "./prepare-release.mjs";

const required = [
  "system.windows",
  "runtime.node",
  "git.executable",
  "registry.read",
  "storage.command",
  "storage.control-command",
  "storage.package-integrity",
  "storage.service",
  "storage.install-receipt",
  "storage.component-version",
  "storage.workspace-root",
  "storage.status",
  "projects.registered",
];

export const parseDoctorHealth = (stdout) => {
  const report = JSON.parse(stdout);
  assert(
    report.schemaVersion === 1 &&
      report.ok === true &&
      typeof report.ready === "boolean" &&
      Array.isArray(report.checks) &&
      report.checks.length <= 10000,
    "Invalid Doctor report",
  );
  const counts = { pass: 0, warning: 0, fail: 0 };
  const codes = new Map();
  for (const check of report.checks) {
    assert(
      typeof check.code === "string" &&
        check.code.length > 0 &&
        Object.hasOwn(counts, check.status) &&
        typeof check.message === "string",
      "Invalid Doctor check",
    );
    counts[check.status]++;
    // Project/workspace checks may repeat. Required component checks must be unique.
    if (required.includes(check.code)) assert(!codes.has(check.code), "Duplicate component check");
    codes.set(check.code, check.status);
  }
  assert.deepEqual(report.summary, counts, "Doctor summary mismatch");
  assert.equal(report.ready, counts.fail === 0, "Doctor readiness mismatch");
  for (const code of required) assert(codes.has(code), `Missing Doctor check: ${code}`);
  const ready =
    report.ready &&
    required.every(
      (code) =>
        codes.get(code) === "pass" ||
        (code === "projects.registered" && codes.get(code) === "warning"),
    );
  return { ready, report };
};

/** Transport only; callers must authorize and verify executable identity before invocation. */
export const runDoctorProcess = async ({ node, cli, cwd, timeoutMs = 60000 }) => {
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
    "Invalid health timeout",
  );
  const excluded = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "HONEYBEE_WORKSPACE_STORAGE",
    "ELECTRON_RUN_AS_NODE",
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !excluded.includes(key.toUpperCase())),
  );
  return promisify(execFile)(packageTool, ["doctor", node, cli, cwd, String(timeoutMs)], {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs + 5000,
    maxBuffer: 1024 * 1024,
    killSignal: "SIGKILL",
  });
};

/** Internal read-only Doctor runner. Authorization must authenticate the payload and
 * validate complete package/service policy; launch-file hashes alone are not trust. */
export const checkVersionHealth = async (options, { authorize, run = runDoctorProcess } = {}) => {
  options = { ...options };
  assert(typeof authorize === "function", "Explicit health execution authorization required");
  const context = Object.freeze({
    installationRoot: path.resolve(options.installationRoot),
    version: options.version,
    launchManifestSha256: options.launchManifestSha256,
  });
  assert.equal(await authorize(context), true, "Health execution authorization refused");
  const { directory } = await verifyAppVersion(context);
  try {
    const { stdout, stderr } = await run({
      node: path.join(directory, "runtime/node.exe"),
      cli: path.join(directory, "cli/dist/cli.js"),
      cwd: directory,
      timeoutMs: options.timeoutMs,
    });
    assert(stderr.trim() === "", "Doctor wrote unexpected stderr");
    const health = parseDoctorHealth(stdout);
    await verifyAppVersion(context);
    return { schemaVersion: 1, version: context.version, ...health };
  } catch (error) {
    // A valid report on a nonzero exit is diagnostic evidence, never successful health.
    let report;
    if (typeof error.stdout === "string" && error.stdout.length <= 1024 * 1024) {
      try {
        report = parseDoctorHealth(error.stdout).report;
      } catch {
        /* Preserve failure. */
      }
    }
    return {
      schemaVersion: 1,
      version: context.version,
      ready: false,
      ...(report ? { report } : {}),
      failure: { code: "update.health-failed", message: error.message },
    };
  }
};
