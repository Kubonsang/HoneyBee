import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sha256 } from "./release-manifest.mjs";
import { activateAppPointer, recoverAppPointer } from "./app-activation.mjs";
import { runDoctorProcess } from "./version-health.mjs";

const fixture = async () => {
  const base = path.resolve("output/activation-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const versions = ["0.1.0-beta.11", "0.1.0-beta.12"],
    manifests = [];
  for (const version of versions) {
    const directory = path.join(root, "versions", version);
    const files = {
      "desktop/HoneyBee.exe": `desktop-${version}`,
      "runtime/node.exe": "node",
      "cli/dist/cli.js": "cli",
      "installation.json": JSON.stringify({
        schemaVersion: 1,
        version,
        componentVersion: "same.hb12",
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
      nodeSha256: sha256("node"),
      cliSha256: sha256("cli"),
      installationSha256: sha256(files["installation.json"]),
    });
    await writeFile(path.join(directory, "launch.json"), launch);
    manifests.push(sha256(launch));
  }
  const source = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      activeVersion: versions[0],
      manifestSha256: manifests[0],
    }) + "\n",
  );
  await writeFile(path.join(root, "current.json"), source);
  await writeFile(path.join(root, "user-state"), "preserve");
  return {
    root,
    source,
    options: {
      installationRoot: root,
      sourcePointerSha256: sha256(source),
      targetVersion: versions[1],
      targetManifestSha256: manifests[1],
    },
    hooks: { admit: async () => {}, health: async () => true },
  };
};
const preserved = async (f) => {
  assert.equal(await readFile(path.join(f.root, "user-state"), "utf8"), "preserve");
  assert.deepEqual((await readdir(path.join(f.root, "versions"))).sort(), [
    "0.1.0-beta.11",
    "0.1.0-beta.12",
  ]);
};
test("commits a newer pinned version and retains old version and user data", async () => {
  const f = await fixture();
  const result = await activateAppPointer(f.options, f.hooks);
  assert.equal(result.state, "Committed");
  const current = JSON.parse(await readFile(path.join(f.root, "current.json")));
  assert.equal(current.generation, 2);
  assert.equal(current.activeVersion, f.options.targetVersion);
  assert.equal(
    (
      await recoverAppPointer(
        { ...f.options, transactionDirectory: result.transactionDirectory },
        f.hooks,
      )
    ).state,
    "Committed",
  );
  await preserved(f);
});
test("post-switch health failure restores exact old pointer bytes", async () => {
  const f = await fixture();
  let switched = false;
  const result = await activateAppPointer(f.options, {
    ...f.hooks,
    checkpoint: async (state) => {
      if (state === "switched") switched = true;
    },
    health: async ({ version }) => !(switched && version === f.options.targetVersion),
  });
  assert.equal(result.state, "RolledBack");
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
  await preserved(f);
});
test("native process start failure after switching restores the exact source pointer", async () => {
  const f = await fixture();
  const probe = path.join(f.root, "healthy-process.cjs");
  await writeFile(probe, 'process.stdout.write("native-control-ok")');
  assert.equal(
    (await runDoctorProcess({ node: process.execPath, cli: probe, cwd: f.root, timeoutMs: 10000 }))
      .stdout,
    "native-control-ok",
  );
  let failures = 0;
  let switched = false;
  const result = await activateAppPointer(f.options, {
    ...f.hooks,
    checkpoint: async (state) => {
      if (state === "switched") switched = true;
    },
    health: async ({ version }) => {
      if (version !== f.options.targetVersion || !switched) return true;
      await assert.rejects(
        runDoctorProcess({
          node: path.join(f.root, "missing-node.exe"),
          cli: probe,
          cwd: f.root,
          timeoutMs: 10000,
        }),
      );
      failures++;
      return false;
    },
  });
  assert.equal(failures, 1);
  assert.equal(result.state, "RolledBack");
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
  await preserved(f);
});
for (const phase of ["intent", "switched", "validated"])
  test(`exception at ${phase} rolls back safely`, async () => {
    const f = await fixture();
    const result = await activateAppPointer(f.options, {
      ...f.hooks,
      checkpoint: async (state) => {
        if (state === phase) throw new Error("injected");
      },
    });
    assert.equal(result.state, "RolledBack");
    assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
    await preserved(f);
  });
test("missing admission, stale source or failed preflight cannot replace the pointer", async () => {
  const f = await fixture();
  await assert.rejects(activateAppPointer(f.options));
  await assert.rejects(
    activateAppPointer({ ...f.options, sourcePointerSha256: sha256("wrong") }, f.hooks),
  );
  await assert.rejects(activateAppPointer(f.options, { ...f.hooks, health: async () => false }));
  await assert.rejects(
    activateAppPointer(f.options, {
      ...f.hooks,
      admit: async () => {
        throw new Error("unsigned release");
      },
    }),
  );
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
  await preserved(f);
});
test("unknown pointer is never overwritten during rollback", async () => {
  const f = await fixture();
  const other = Buffer.from("external-pointer");
  await assert.rejects(
    activateAppPointer(f.options, {
      ...f.hooks,
      checkpoint: async (state) => {
        if (state === "switched") {
          await writeFile(path.join(f.root, "current.json"), other);
          throw new Error("external change");
        }
      },
    }),
    /needs recovery/u,
  );
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), other);
  await assert.rejects(activateAppPointer(f.options, f.hooks), /Interrupted activation/u);
  await preserved(f);
});
test("service compatibility change is rejected before admission", async () => {
  const f = await fixture();
  const directory = path.join(f.root, "versions", f.options.targetVersion);
  const installation = JSON.stringify({
    schemaVersion: 1,
    version: f.options.targetVersion,
    componentVersion: "other.hb13",
  });
  await writeFile(path.join(directory, "installation.json"), installation);
  const launch = JSON.parse(await readFile(path.join(directory, "launch.json")));
  launch.installationSha256 = sha256(installation);
  const bytes = JSON.stringify(launch);
  await writeFile(path.join(directory, "launch.json"), bytes);
  await assert.rejects(
    activateAppPointer(
      { ...f.options, targetManifestSha256: sha256(bytes) },
      { ...f.hooks, admit: async () => assert.fail("service migration admitted") },
    ),
    /Service migration/u,
  );
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
});
for (const phase of ["intent", "switched"])
  test(
    `process death at ${phase} conservatively restores source on recovery`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(),
        module = pathToFileURL(path.resolve("scripts/update/app-activation.mjs")).href;
      const script = `import {activateAppPointer} from ${JSON.stringify(module)};await activateAppPointer(JSON.parse(process.argv[1]),{admit:async()=>{},health:async()=>true,checkpoint:async(state,dir)=>{if(state===${JSON.stringify(phase)}){process.stdout.write(dir+'\\n');await new Promise(r=>setTimeout(r,60000));}}});`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, JSON.stringify(f.options)],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      t.after(() => child.kill());
      let stderr = "";
      child.stderr.on("data", (b) => {
        stderr += b;
      });
      const exited = once(child, "exit");
      const directory = await Promise.race([
        once(child.stdout, "data").then(([b]) => b.toString().trim()),
        exited.then(() => {
          throw new Error(stderr);
        }),
      ]);
      child.kill();
      await exited;
      let result;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          result = await recoverAppPointer(
            { ...f.options, transactionDirectory: directory },
            f.hooks,
          );
          break;
        } catch (error) {
          if (!/lock unavailable/u.test(error.message) || attempt === 39) throw error;
          await setTimeout(50);
        }
      }
      assert.equal(result.state, "RolledBack");
      assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
      await preserved(f);
      assert.equal(
        (await recoverAppPointer({ ...f.options, transactionDirectory: directory }, f.hooks)).state,
        "RolledBack",
      );
    },
  );

test("Windows replacement failure leaves the old pointer intact", async () => {
  const f = await fixture(),
    current = path.join(f.root, "current.json");
  await chmod(current, 0o444);
  try {
    const result = await activateAppPointer(f.options, f.hooks);
    assert.equal(result.state, "RolledBack");
    assert.deepEqual(await readFile(current), f.source);
  } finally {
    await chmod(current, 0o666);
  }
});
test("unhealthy rollback source is retained for explicit recovery rather than activated", async () => {
  const f = await fixture();
  let directory;
  await assert.rejects(
    activateAppPointer(f.options, {
      ...f.hooks,
      checkpoint: async (state, dir) => {
        directory = dir;
        if (state === "switched") throw new Error("health failure");
      },
      health: async ({ phase }) => phase !== "rollback",
    }),
    /needs recovery/u,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(f.root, "current.json"))).activeVersion,
    f.options.targetVersion,
  );
  assert.equal(
    (await recoverAppPointer({ ...f.options, transactionDirectory: directory }, f.hooks)).state,
    "RolledBack",
  );
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
});
test("incomplete validation blocks activation before admission", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "update/transactions/txn-orphan"), { recursive: true });
  await assert.rejects(
    activateAppPointer(f.options, {
      ...f.hooks,
      admit: async () => assert.fail("pending validation admitted"),
    }),
    /Interrupted validation/u,
  );
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.source);
});
