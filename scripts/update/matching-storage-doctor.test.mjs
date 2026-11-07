import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMatchingStorageDoctor } from "./matching-storage-doctor.mjs";
import { sha256 } from "./release-manifest.mjs";

async function fixture(changedStorage = false) {
  const parent = path.resolve("output/matching-doctor-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const pointers = [];
  for (const version of ["0.1.0-beta.38", "0.1.0-beta.39"]) {
    const directory = path.join(root, "versions", version);
    const files = {
      "desktop/HoneyBee.exe": "desktop",
      "runtime/node.exe": "node",
      "cli/dist/cli.js": version,
      "installation.json": JSON.stringify({
        schemaVersion: 1,
        version,
        componentVersion: "same.hb17",
        clientSha256: sha256("client"),
        controlSha256: sha256(changedStorage && version.endsWith("39") ? "changed" : "control"),
      }),
    };
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), bytes);
    }
    const launch = JSON.stringify({
      schemaVersion: 1,
      version,
      desktopSha256: sha256(files["desktop/HoneyBee.exe"]),
      nodeSha256: sha256(files["runtime/node.exe"]),
      cliSha256: sha256(files["cli/dist/cli.js"]),
      installationSha256: sha256(files["installation.json"]),
    });
    await writeFile(path.join(directory, "launch.json"), launch);
    pointers.push({ activeVersion: version, manifestSha256: sha256(launch) });
  }
  const sourceDirectory = path.join(root, "versions", pointers[0].activeVersion);
  return {
    root,
    source: pointers[0],
    target: pointers[1],
    request: {
      cwd: sourceDirectory,
      node: path.join(sourceDirectory, "runtime/node.exe"),
      cli: path.join(sourceDirectory, "cli/dist/cli.js"),
    },
  };
}
const report = () => {
  const checks = [
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
  ].map((code) => ({ code, status: "pass", message: "fixture" }));
  return {
    schemaVersion: 1,
    scope: "installation",
    ok: true,
    ready: true,
    checks,
    summary: { pass: checks.length, warning: 0, fail: 0 },
  };
};
for (const scenario of [
  "valid",
  "changed-storage",
  "denied",
  "source-changed",
  "target-changed",
  "unscoped",
  "process-failed",
  "service-failed",
]) {
  test(`new scoped Doctor for unchanged storage: ${scenario}`, async () => {
    const f = await fixture(scenario === "changed-storage");
    let calls = 0,
      authorizations = 0;
    const run = createMatchingStorageDoctor(
      {
        installationRoot: f.root,
        source: f.source,
        target: f.target,
        authorize: async () => {
          authorizations++;
          if (scenario === "denied") throw new Error("denied");
        },
      },
      {
        run: async (options) => {
          calls++;
          assert.equal(options.cwd, path.join(f.root, "versions", f.target.activeVersion));
          if (scenario === "process-failed")
            throw Object.assign(new Error("exit status 1"), { stdout: JSON.stringify(report()) });
          if (scenario.endsWith("changed"))
            await writeFile(
              path.join(
                f.root,
                "versions",
                scenario === "source-changed" ? f.source.activeVersion : f.target.activeVersion,
                "cli/dist/cli.js",
              ),
              "changed",
            );
          const result = report();
          if (scenario === "unscoped") delete result.scope;
          if (scenario === "service-failed") {
            result.checks[7].status = "fail";
            result.summary.pass--;
            result.summary.fail++;
            result.ready = false;
          }
          return { stdout: JSON.stringify(result), stderr: "" };
        },
      },
    );
    if (["valid", "service-failed"].includes(scenario)) {
      const result = JSON.parse((await run(f.request)).stdout);
      assert.equal(result.ready, scenario === "valid");
      assert.equal(result.installationDoctorVersion, f.target.activeVersion);
      assert.equal(authorizations, 4);
    } else await assert.rejects(run(f.request));
    assert.equal(calls, ["changed-storage", "denied"].includes(scenario) ? 0 : 1);
  });
}
