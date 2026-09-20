import { windowsTest } from "../test-support/windows-test.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { withInstallationUpdateLock } from "./installation-lock.mjs";
import { runUpdateTransaction } from "./update-transaction.mjs";
import { createUpdatePlan } from "./update-plan.mjs";
import { fixture, preserved } from "./prepare-fixture.mjs";
import { sha256 } from "./release-manifest.mjs";
const setup = async () => {
  const f = await fixture();
  const observation = {
    status: "app-only-candidate",
    activationAllowed: false,
    sourceVersion: f.source.currentVersion,
    targetVersion: "0.1.0-beta.12",
    sourceComponentVersion: f.source.storageComponentVersion,
    sourceEvidenceSha256: sha256("evidence"),
    sourcePointerSha256: sha256(await readFile(path.join(f.installationRoot, "current.json"))),
    manifestSha256: f.manifestSha256,
    parentCount: 0,
    remainingGates: ["durable-activation-and-recovery"],
  };
  const observe = async () => ({ ...observation });
  const plan = await createUpdatePlan(
    { ...f, bootstrapperVersion: f.source.bootstrapperVersion, channel: f.source.channel },
    { observe },
  );
  return { f, options: { ...plan, installationRoot: f.installationRoot }, observe, observation };
};
windowsTest("Windows handle excludes a second owner and can be reused after release", async () => {
  const f = await setup();
  await withInstallationUpdateLock(f.f.installationRoot, async () => {
    await assert.rejects(
      withInstallationUpdateLock(f.f.installationRoot, () => assert.fail("second owner entered")),
    );
  });
  await withInstallationUpdateLock(f.f.installationRoot, async ({ assertHeld }) => assertHeld());
});
windowsTest("validation transaction is durable but never activates", async () => {
  const f = await setup();
  const result = await runUpdateTransaction(f.options, { observe: f.observe });
  assert.equal(result.activationAllowed, false);
  assert.deepEqual((await readdir(result.transactionDirectory)).sort(), [
    "001-Created.json",
    "002-Validating.json",
    "003-Validated.json",
  ]);
  await preserved(f.f);
});
windowsTest(
  "failed transaction blocks new work until explicit recovery with the same plan",
  async () => {
    const f = await setup();
    let directory;
    await assert.rejects(
      runUpdateTransaction(f.options, {
        observe: f.observe,
        checkpoint: async (state, dir) => {
          directory = dir;
          if (state === "validating") throw new Error("injected interruption");
        },
      }),
    );
    await assert.rejects(
      runUpdateTransaction(f.options, { observe: f.observe }),
      /Interrupted transaction/u,
    );
    await assert.rejects(
      runUpdateTransaction(
        { ...f.options, transactionDirectory: directory, planSha256: sha256("wrong") },
        { observe: f.observe },
      ),
      /pin mismatch/u,
    );
    const result = await runUpdateTransaction(
      { ...f.options, transactionDirectory: directory },
      { observe: f.observe },
    );
    assert.equal(result.state, "Validated");
    await preserved(f.f);
  },
);
windowsTest("stale failed plan can be abandoned without deleting its files", async () => {
  const f = await setup();
  let directory;
  await assert.rejects(
    runUpdateTransaction(f.options, {
      observe: f.observe,
      checkpoint: async (state, dir) => {
        directory = dir;
        if (state === "created") throw new Error("stop");
      },
    }),
  );
  const result = await runUpdateTransaction(
    { ...f.options, transactionDirectory: directory, abandon: true },
    { observe: () => assert.fail("abandon queried service") },
  );
  assert.equal(result.state, "Abandoned");
  assert((await readdir(directory)).some((name) => name.endsWith("-Abandoned.json")));
  await runUpdateTransaction(f.options, { observe: f.observe });
  await preserved(f.f);
});
windowsTest(
  "killing a transaction process releases ownership and leaves recoverable intent",
  { timeout: 20000 },
  async (t) => {
    const f = await setup();
    const module = pathToFileURL(path.resolve("scripts/update/update-transaction.mjs")).href;
    const script = `import {runUpdateTransaction} from ${JSON.stringify(module)};const options=JSON.parse(process.argv[1]);await runUpdateTransaction(options,{checkpoint:async(state,directory)=>{if(state==='validating'){process.stdout.write(directory+'\\n');await new Promise(r=>setTimeout(r,60000));}}});`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(f.options)],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    const data = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => chunk.toString()),
      exited.then(() => {
        throw new Error(stderr || "child exited before checkpoint");
      }),
    ]);
    const directory = data.trim();
    child.kill();
    await exited;
    // The orphaned helper exits on pipe EOF; bounded retry only while Windows releases its handle.
    let result;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        result = await runUpdateTransaction(
          { ...f.options, transactionDirectory: directory },
          { observe: f.observe },
        );
        break;
      } catch (error) {
        if (!/lock unavailable/u.test(error.message) || attempt === 39) throw error;
        await setTimeout(50);
      }
    }
    assert.equal(result.state, "Validated");
    await preserved(f.f);
  },
);
windowsTest("installation roots have independent locks", async () => {
  const base = path.resolve("output/update-lock-tests");
  await mkdir(base, { recursive: true });
  const a = await mkdtemp(path.join(base, "a-")),
    b = await mkdtemp(path.join(base, "b-"));
  await withInstallationUpdateLock(a, () =>
    withInstallationUpdateLock(b, async ({ assertHeld }) => assertHeld()),
  );
});

windowsTest("corrupt durable journal blocks replay and new work", async () => {
  const f = await setup();
  let directory;
  await assert.rejects(
    runUpdateTransaction(f.options, {
      observe: f.observe,
      checkpoint: async (state, dir) => {
        directory = dir;
        if (state === "validating") throw new Error("stop");
      },
    }),
  );
  await writeFile(path.join(directory, "001-Created.json"), "{truncated");
  await assert.rejects(
    runUpdateTransaction({ ...f.options, transactionDirectory: directory }, { observe: f.observe }),
  );
  await assert.rejects(runUpdateTransaction(f.options, { observe: f.observe }));
  await preserved(f.f);
});
test("redirected update directory cannot acquire a lock", async () => {
  const base = path.resolve("output/update-lock-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "redirect-")),
    other = await mkdtemp(path.join(base, "target-"));
  await symlink(other, path.join(root, "update"), "junction");
  await assert.rejects(withInstallationUpdateLock(root, () => assert.fail("redirect admitted")));
  assert.deepEqual(await readdir(other), []);
});
