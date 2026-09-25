import { windowsTest } from "../test-support/windows-test.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { checkVersionHealth, parseDoctorHealth, runDoctorProcess } from "./version-health.mjs";
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
  ].map((code) => ({ code, status: "pass", message: "fixture" }));
  checks.push({ code: "projects.registered", status: "warning", message: "none registered" });
  return {
    schemaVersion: 1,
    ok: true,
    ready: true,
    checks,
    summary: { pass: 12, warning: 1, fail: 0 },
  };
};
test("complete Doctor report permits no-project warning", () => {
  assert.equal(parseDoctorHealth(JSON.stringify(report())).ready, true);
});

windowsTest("nonzero child exit preserves stdout and stderr diagnostics", async () => {
  const cwd = await directory(),
    cli = path.join(cwd, "failure.cjs");
  await writeFile(
    cli,
    "process.stdout.write('diagnostic-json');process.stderr.write('diagnostic-error');process.exitCode=1;",
  );
  await assert.rejects(runDoctorProcess({ node: process.execPath, cli, cwd }), (error) => {
    assert.equal(error.stdout, "diagnostic-json");
    assert.match(error.stderr, /diagnostic-error/u);
    return true;
  });
});

test("valid report from a failed process cannot become successful health", async () => {
  const f = await installed();
  const result = await checkVersionHealth(f.options, {
    authorize: async () => true,
    run: async () => {
      throw Object.assign(new Error("exit status 1"), { stdout: JSON.stringify(report()) });
    },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.report, report());
});
for (const [name, alter] of [
  [
    "empty checks",
    (r) => {
      r.checks = [];
      r.summary = { pass: 0, warning: 0, fail: 0 };
    },
  ],
  [
    "summary",
    (r) => {
      r.summary.pass++;
    },
  ],
  [
    "duplicate",
    (r) => {
      r.checks.push(r.checks[0]);
      r.summary.pass++;
    },
  ],
  [
    "false success",
    (r) => {
      r.ok = false;
    },
  ],
  [
    "readiness",
    (r) => {
      r.ready = false;
    },
  ],
])
  test(`rejects malformed ${name}`, () => {
    const r = report();
    alter(r);
    assert.throws(() => parseDoctorHealth(JSON.stringify(r)));
  });
test("valid failed or component-warning reports are not healthy", () => {
  for (const status of ["fail", "warning"]) {
    const r = report();
    r.checks[0].status = status;
    r.summary.pass--;
    r.summary[status]++;
    r.ready = status !== "fail";
    assert.equal(parseDoctorHealth(JSON.stringify(r)).ready, false);
  }
});
const directory = async () => {
  const base = path.resolve("output/version-health-tests");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, "case-"));
};
for (const [name, script] of [
  ["nonzero exit", "process.exit(2)"],
  ["timeout", "setInterval(()=>{}, 1000)"],
  ["oversized output", "process.stdout.write('x'.repeat(2*1024*1024))"],
])
  test(`real child rejects ${name}`, async () => {
    const cwd = await directory(),
      cli = path.join(cwd, "probe.cjs");
    await writeFile(cli, script);
    await assert.rejects(
      runDoctorProcess({
        node: process.execPath,
        cli,
        cwd,
        timeoutMs: name === "timeout" ? 200 : 5000,
      }),
    );
  });
windowsTest(
  "real child receives fixed Doctor arguments and sanitized Node environment",
  async () => {
    const cwd = await directory(),
      cli = path.join(cwd, "probe.cjs");
    await writeFile(
      cli,
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2), options:process.env.NODE_OPTIONS}))",
    );
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=nonexistent-health-test-module";
    try {
      const result = JSON.parse(
        (await runDoctorProcess({ node: process.execPath, cli, cwd })).stdout,
      );
      assert.deepEqual(result, { args: ["doctor", "--json"] });
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  },
);
const installed = async () => {
  const root = await directory(),
    version = "0.1.0-beta.12";
  const target = path.join(root, "versions", version);
  const files = {
    "desktop/HoneyBee.exe": "desktop",
    "runtime/node.exe": "node",
    "cli/dist/cli.js": "cli",
    "installation.json": JSON.stringify({
      schemaVersion: 1,
      version,
      componentVersion: "same.hb12",
    }),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), bytes);
  }
  const launch = JSON.stringify({
    schemaVersion: 1,
    version,
    desktopSha256: sha256("desktop"),
    nodeSha256: sha256("node"),
    cliSha256: sha256("cli"),
    installationSha256: sha256(files["installation.json"]),
  });
  await writeFile(path.join(target, "launch.json"), launch);
  await writeFile(path.join(root, "current.json"), "unchanged old pointer");
  return {
    root,
    target,
    options: { installationRoot: root, version, launchManifestSha256: sha256(launch) },
  };
};
test("health runner pins explicit candidate paths and leaves pointer untouched", async () => {
  const f = await installed();
  const result = await checkVersionHealth(f.options, {
    authorize: async () => true,
    run: async (request) => {
      assert.equal(request.node, path.join(f.target, "runtime/node.exe"));
      assert.equal(request.cli, path.join(f.target, "cli/dist/cli.js"));
      assert.equal(request.cwd, f.target);
      return { stdout: JSON.stringify(report()), stderr: "" };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), "unchanged old pointer");
});
test("unauthorized or changed executable cannot run", async () => {
  const f = await installed();
  const run = async () => assert.fail("must not execute");
  await assert.rejects(checkVersionHealth(f.options, { run }), /authorization/u);
  await assert.rejects(
    checkVersionHealth(f.options, { authorize: async () => false, run }),
    /refused/u,
  );
  await writeFile(path.join(f.target, "runtime/node.exe"), "tampered");
  await assert.rejects(
    checkVersionHealth(f.options, { authorize: async () => true, run }),
    /changed/u,
  );
});
test("invalid output, stderr, process failure and post-run tampering fail health", async () => {
  for (const mode of ["json", "stderr", "exit", "tamper"]) {
    const f = await installed();
    const result = await checkVersionHealth(f.options, {
      authorize: async () => true,
      run: async () => {
        if (mode === "exit") throw new Error("process failure");
        if (mode === "tamper") await writeFile(path.join(f.target, "cli/dist/cli.js"), "changed");
        return {
          stdout: mode === "json" ? "not json" : JSON.stringify(report()),
          stderr: mode === "stderr" ? "error" : "",
        };
      },
    });
    assert.equal(result.ready, false);
    assert.equal(result.failure.code, "update.health-failed");
  }
});
