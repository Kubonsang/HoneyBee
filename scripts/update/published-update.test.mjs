import { windowsTest } from "../test-support/windows-test.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { fixture, version, component } from "./prepare-fixture.mjs";
import { sha256 } from "./release-manifest.mjs";
import { createUpdatePlan } from "./update-plan.mjs";
import { publishPreparedVersion } from "./publish-version.mjs";
import { updateAndRestartWithDoctor } from "./desktop-update-lifecycle.mjs";
import { withApplicationActivity } from "./application-activity.mjs";
import { activatePublishedUpdate, recoverPublishedUpdate } from "./published-update.mjs";
import {
  activatePublishedUpdateWithDoctor,
  recoverPublishedUpdateWithDoctor,
} from "./doctor-update.mjs";

const setup = async () => {
  const f = await fixture();
  const old = path.join(f.installationRoot, "versions", f.source.currentVersion);
  const installation = JSON.stringify({
    schemaVersion: 1,
    version: f.source.currentVersion,
    componentVersion: component,
  });
  const files = {
    "desktop/HoneyBee.exe": "old desktop",
    "runtime/node.exe": "old node",
    "cli/dist/cli.js": "old cli",
    "installation.json": installation,
  };
  const launch = JSON.stringify({
    schemaVersion: 1,
    version: f.source.currentVersion,
    desktopSha256: sha256(files["desktop/HoneyBee.exe"]),
    nodeSha256: sha256(files["runtime/node.exe"]),
    cliSha256: sha256(files["cli/dist/cli.js"]),
    installationSha256: sha256(installation),
  });
  files["launch.json"] = launch;
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(old, name)), { recursive: true });
    await writeFile(path.join(old, name), bytes);
  }
  const pointer = JSON.stringify({
    schemaVersion: 1,
    generation: 1,
    activeVersion: f.source.currentVersion,
    manifestSha256: sha256(launch),
  });
  await writeFile(path.join(f.installationRoot, "current.json"), pointer);
  const observation = {
    status: "app-only-candidate",
    activationAllowed: false,
    sourceVersion: f.source.currentVersion,
    targetVersion: version,
    sourceComponentVersion: component,
    sourceEvidenceSha256: sha256("service evidence"),
    sourcePointerSha256: sha256(pointer),
    manifestSha256: f.manifestSha256,
    parentCount: 0,
    remainingGates: ["qualification"],
  };
  const hooks = {
    observe: async () => ({ ...observation }),
    admit: async () => true,
    health: async () => true,
  };
  const plan = await createUpdatePlan(
    { ...f, bootstrapperVersion: f.source.bootstrapperVersion, channel: f.source.channel },
    hooks,
  );
  const options = {
    installationRoot: f.installationRoot,
    planPath: plan.planPath,
    planSha256: plan.planSha256,
  };
  const publication = await publishPreparedVersion(options, hooks);
  options.publicationDirectory = publication.publicationDirectory;
  return { options, hooks, observation, pointer, old, files, target: publication.directory };
};
const preserved = async (f, oldPointer = true) => {
  if (oldPointer)
    assert.equal(
      await readFile(path.join(f.options.installationRoot, "current.json"), "utf8"),
      f.pointer,
    );
  assert.equal(
    await readFile(path.join(f.options.installationRoot, "user-state"), "utf8"),
    "preserve",
  );
  for (const [name, bytes] of Object.entries(f.files))
    assert.equal(await readFile(path.join(f.old, name), "utf8"), bytes);
};

const doctorOutput = () => {
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
    stdout: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      ready: true,
      summary: { pass: checks.length, warning: 0, fail: 0 },
      checks,
    }),
    stderr: "",
  };
};

for (const rollback of [false, true])
  windowsTest(
    `Desktop lifecycle composes real pointer ${rollback ? "rollback" : "commit"} with Doctor`,
    async () => {
      const f = await setup();
      await writeFile(
        path.join(f.options.installationRoot, "HoneyBeeLauncher.exe"),
        "fixture launcher",
      );
      let phase;
      let restarted = false;
      const result = await updateAndRestartWithDoctor(
        {
          ...f.options,
          sourcePointerSha256: sha256(f.pointer),
          launcherSha256: sha256("fixture launcher"),
        },
        {
          ...f.hooks,
          requestShutdown: async ({ requestId }) => ({ requestId, status: "accepted" }),
          authorizeHealth: async (context) => {
            phase = context.phase;
            return true;
          },
          runDoctor: async () => {
            if (rollback && phase === "target-after-switch")
              throw new Error("Candidate Doctor failed");
            return doctorOutput();
          },
          authorizeRestart: async () => true,
          dispatchLauncher: async () => {
            await withApplicationActivity(
              { installationRoot: f.options.installationRoot, mode: "shared" },
              async () => {},
            );
            restarted = true;
          },
        },
      );
      assert.equal(result.state, rollback ? "RolledBack" : "Committed");
      assert.equal(result.restart, "Dispatched");
      assert(restarted);
      await preserved(f, rollback);
      assert.equal(
        JSON.parse(await readFile(path.join(f.options.installationRoot, "current.json")))
          .activeVersion,
        rollback ? JSON.parse(f.pointer).activeVersion : version,
      );
    },
  );

windowsTest(
  "Doctor adapter selects pinned versions for activation and committed recovery",
  async () => {
    const f = await setup(),
      phases = [],
      directories = [];
    const hooks = {
      ...f.hooks,
      authorizeHealth: async (context) => {
        phases.push(context.phase);
        return true;
      },
      runDoctor: async (request) => {
        directories.push(request.cwd);
        return doctorOutput();
      },
    };
    const result = await activatePublishedUpdateWithDoctor(f.options, hooks);
    assert.equal(result.state, "Committed");
    assert.deepEqual(phases, ["source-health", "target-before-switch", "target-after-switch"]);
    assert.deepEqual(directories, [f.old, f.target, f.target]);
    assert.equal(result.healthChecks.length, 3);
    const recovered = await recoverPublishedUpdateWithDoctor(
      { ...f.options, transactionDirectory: result.transactionDirectory },
      hooks,
    );
    assert.equal(recovered.state, "Committed");
    assert.equal(phases.at(-1), "committed-health");
    await preserved(f, false);
  },
);

windowsTest(
  "Doctor adapter refuses absent authorization and pre-switch Doctor failure",
  async () => {
    const f = await setup();
    await assert.rejects(activatePublishedUpdateWithDoctor(f.options, f.hooks), /authorization/u);
    await assert.rejects(
      activatePublishedUpdateWithDoctor(f.options, {
        ...f.hooks,
        authorizeHealth: async () => false,
        runDoctor: async () => assert.fail("must not run"),
      }),
    );
    await assert.rejects(
      activatePublishedUpdateWithDoctor(f.options, {
        ...f.hooks,
        authorizeHealth: async () => true,
        runDoctor: async () => {
          throw new Error("Doctor timed out");
        },
      }),
      (error) => {
        assert.equal(error.healthChecks[0].ready, false);
        return true;
      },
    );
    await preserved(f);
  },
);

windowsTest("Doctor adapter rolls back after candidate Doctor process failure", async () => {
  const f = await setup(),
    directories = [];
  let phase;
  const result = await activatePublishedUpdateWithDoctor(f.options, {
    ...f.hooks,
    authorizeHealth: async (context) => {
      phase = context.phase;
      return true;
    },
    runDoctor: async (request) => {
      directories.push(request.cwd);
      if (phase === "target-after-switch")
        throw Object.assign(new Error("nonzero exit"), { stdout: doctorOutput().stdout });
      return doctorOutput();
    },
  });
  assert.equal(result.state, "RolledBack");
  assert.deepEqual(directories, [f.old, f.target, f.target, f.old]);
  assert.equal(result.healthChecks[2].ready, false);
  await preserved(f);
});

windowsTest("Doctor recovery uses saved source pin even while candidate is selected", async () => {
  const f = await setup();
  let transactionDirectory, phase;
  await assert.rejects(
    activatePublishedUpdateWithDoctor(f.options, {
      ...f.hooks,
      authorizeHealth: async (context) => {
        phase = context.phase;
        return true;
      },
      runDoctor: async () => {
        if (phase === "rollback") throw new Error("source unavailable");
        return doctorOutput();
      },
      checkpoint: async (state, directory) => {
        transactionDirectory = directory;
        if (state === "switched") throw new Error("interrupted");
      },
    }),
    /needs recovery/u,
  );
  const recoveryOptions = { ...f.options, transactionDirectory };
  const directories = [];
  const hooks = {
    ...f.hooks,
    authorizeHealth: async () => true,
    runDoctor: async (request) => {
      directories.push(request.cwd);
      return doctorOutput();
    },
  };
  assert.equal(
    (await recoverPublishedUpdateWithDoctor(recoveryOptions, hooks)).state,
    "RolledBack",
  );
  assert.equal(
    (await recoverPublishedUpdateWithDoctor(recoveryOptions, hooks)).state,
    "RolledBack",
  );
  assert.deepEqual(directories, [f.old, f.old]);
  await preserved(f);
});

windowsTest(
  "published plan activates and terminal recovery verifies health and full payload",
  async () => {
    const f = await setup();
    const result = await activatePublishedUpdate(f.options, f.hooks);
    assert.equal(result.state, "Committed");
    assert.equal(
      JSON.parse(await readFile(path.join(f.options.installationRoot, "current.json")))
        .activeVersion,
      version,
    );
    const recovery = { ...f.options, transactionDirectory: result.transactionDirectory };
    assert.equal((await recoverPublishedUpdate(recovery, f.hooks)).state, "Committed");
    await assert.rejects(
      recoverPublishedUpdate(recovery, { ...f.hooks, health: async () => false }),
      /Terminal activation health/u,
    );
    await writeFile(path.join(f.target, "desktop/resources/app.asar"), "tampered");
    await assert.rejects(recoverPublishedUpdate(recovery, f.hooks));
    await preserved(f, false);
  },
);

windowsTest("missing or false admission cannot activate", async () => {
  const f = await setup();
  await assert.rejects(activatePublishedUpdate(f.options), /Explicit admission/u);
  for (const value of [false, undefined])
    await assert.rejects(
      activatePublishedUpdate(f.options, { ...f.hooks, admit: async () => value }),
      /admission refused/u,
    );
  await preserved(f);
});

windowsTest("source drift after publication blocks activation", async () => {
  const f = await setup();
  f.observation.sourceEvidenceSha256 = sha256("changed service");
  await assert.rejects(activatePublishedUpdate(f.options, f.hooks), /stale/u);
  await preserved(f);
});

windowsTest("unpublished marker and wrong plan pin are refused", async () => {
  const f = await setup();
  await assert.rejects(
    activatePublishedUpdate({ ...f.options, planSha256: sha256("wrong") }, f.hooks),
    /SHA-256/u,
  );
  await writeFile(path.join(f.options.publicationDirectory, "Published.json"), "{}");
  await assert.rejects(activatePublishedUpdate(f.options, f.hooks));
  await preserved(f);
});

for (const phase of ["target-before-switch", "target-after-switch"])
  windowsTest(`whole payload mutation during ${phase} prevents commitment`, async () => {
    const f = await setup();
    const operation = activatePublishedUpdate(f.options, {
      ...f.hooks,
      health: async (context) => {
        if (context.phase === phase)
          await writeFile(path.join(f.target, "desktop/resources/app.asar"), "tampered");
        return true;
      },
    });
    if (phase === "target-before-switch") await assert.rejects(operation);
    else assert.equal((await operation).state, "RolledBack");
    await preserved(f);
  });

windowsTest("source drift during pre-switch health blocks pointer replacement", async () => {
  const f = await setup();
  await assert.rejects(
    activatePublishedUpdate(f.options, {
      ...f.hooks,
      health: async ({ phase }) => {
        if (phase === "target-before-switch")
          f.observation.sourceEvidenceSha256 = sha256("changed");
        return true;
      },
    }),
    /stale/u,
  );
  await preserved(f);
});

windowsTest("failed post-switch health rolls back through the composed path", async () => {
  const f = await setup();
  const result = await activatePublishedUpdate(f.options, {
    ...f.hooks,
    health: async ({ phase }) => phase !== "target-after-switch",
  });
  assert.equal(result.state, "RolledBack");
  assert.equal(
    (
      await recoverPublishedUpdate(
        { ...f.options, transactionDirectory: result.transactionDirectory },
        f.hooks,
      )
    ).state,
    "RolledBack",
  );
  await preserved(f);
});

windowsTest(
  "explicit recovery restores source even with corrupt target and changed live pointer",
  async () => {
    const f = await setup();
    let transactionDirectory;
    await assert.rejects(
      activatePublishedUpdate(f.options, {
        ...f.hooks,
        checkpoint: async (state, directory) => {
          transactionDirectory = directory;
          if (state === "switched") throw new Error("interruption");
        },
        health: async ({ phase }) => phase !== "rollback",
      }),
      /needs recovery/u,
    );
    await writeFile(path.join(f.target, "desktop/HoneyBee.exe"), "corrupt target");
    const options = { ...f.options, transactionDirectory };
    await assert.rejects(
      recoverPublishedUpdate(options, { ...f.hooks, admit: async () => false }),
      /admission refused/u,
    );
    assert.equal((await recoverPublishedUpdate(options, f.hooks)).state, "RolledBack");
    await preserved(f);
  },
);

windowsTest(
  "process death after composed pointer switch recovers the previous version",
  { timeout: 20000 },
  async (t) => {
    const f = await setup();
    const module = pathToFileURL(path.resolve("scripts/update/published-update.mjs")).href;
    const script = `import {activatePublishedUpdate} from ${JSON.stringify(module)};
    await activatePublishedUpdate(JSON.parse(process.argv[1]), {
      observe: async()=>JSON.parse(process.argv[2]), admit:async()=>true, health:async()=>true,
      checkpoint:async(state, directory)=>{if(state==='switched'){
        process.stdout.write(directory+'\\n');await new Promise(r=>setTimeout(r,60000));
      }}
    });`;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(f.options),
        JSON.stringify(f.observation),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const exited = once(child, "exit");
    const transactionDirectory = await Promise.race([
      once(child.stdout, "data").then(([bytes]) => bytes.toString().trim()),
      exited.then(() => {
        throw new Error(stderr);
      }),
    ]);
    child.kill();
    await exited;
    let result;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        result = await recoverPublishedUpdate({ ...f.options, transactionDirectory }, f.hooks);
        break;
      } catch (error) {
        if (!/lock unavailable/u.test(error.message) || attempt === 39) throw error;
        await setTimeout(50);
      }
    }
    assert.equal(result.state, "RolledBack");
    await preserved(f);
  },
);
