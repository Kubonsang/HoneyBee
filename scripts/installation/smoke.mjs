import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
assert(
  process.argv[2] && path.isAbsolute(process.argv[2]),
  "Pass an absolute assembled installation root",
);
const root = process.argv[2];
const current = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));
const release = path.join(root, "versions", current.activeVersion);
const temporary = await mkdtemp(path.join(tmpdir(), "honeybee-installation-smoke-"));
const registryRoot = path.join(temporary, "registry");
const shim = path.join(root, "bin/honeybee.exe");
try {
  const version = await run(shim, ["--version"], {
    cwd: temporary,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(version.stdout.trim(), current.activeVersion);
  const list = await run(shim, ["project", "list", "--json", "--data-root", registryRoot], {
    cwd: temporary,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.deepEqual(JSON.parse(list.stdout).projects, []);
  // A bound fixture deliberately points at a removed ZIP. Doctor must inspect the
  // current managed payload; it may still report the machine service as unavailable.
  await mkdir(registryRoot, { recursive: true });
  const registry = JSON.stringify({
    schemaVersion: 2,
    projects: [
      {
        schemaVersion: 2,
        projectId: "fixture",
        label: "fixture",
        unityProjectPath: temporary,
        repositoryRoot: temporary,
        unityRelativePath: "",
        workspaceRoot: temporary,
        storageCommand: path.join(temporary, "removed-zip/client.exe"),
        storageBinding: { kind: "managed-v1", installationRoot: root },
        createdAt: "2026-09-10T00:00:00.000Z",
      },
    ],
    workspaces: [],
    removalReceipts: [],
  });
  const registryPath = path.join(registryRoot, "workspace-registry-v2.json");
  await writeFile(registryPath, registry);
  const doctor = await run(shim, ["doctor", "--json", "--data-root", registryRoot], {
    cwd: temporary,
    windowsHide: true,
    timeout: 30_000,
  }).catch((error) => {
    if (error.code !== 1 || !error.stdout) throw error;
    return error;
  });
  const report = JSON.parse(doctor.stdout);
  assert(
    report.checks.some(
      (check) => check.code === "project.storage-tools" && check.status === "pass",
    ),
  );
  assert(
    report.checks.some(
      (check) => check.code === "storage.package-integrity" && check.status === "pass",
    ),
  );
  assert.equal(await readFile(registryPath, "utf8"), registry);
  const resultPath = path.join(temporary, "desktop-result.json");
  await run(
    path.join(release, "desktop/HoneyBee.exe"),
    [
      "--user-data-dir=" + path.join(temporary, "profile"),
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--disable-software-rasterizer",
      "--no-sandbox",
    ],
    {
      cwd: temporary,
      windowsHide: true,
      timeout: 45_000,
      env: {
        ...process.env,
        HONEYBEE_DESKTOP_SMOKE: "desktop-smoke-v2",
        HONEYBEE_DESKTOP_SMOKE_RESULT: resultPath,
      },
    },
  );
  assert.equal(JSON.parse(await readFile(resultPath, "utf8")).stage, "passed");
  process.stdout.write(
    "Assembled CLI, private runtime, managed binding and Desktop IPC/UI smoke passed.\n",
  );
} finally {
  const relative = path.relative(tmpdir(), temporary);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
