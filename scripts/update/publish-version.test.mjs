import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fixture } from "./prepare-fixture.mjs";
import { createUpdatePlan } from "./update-plan.mjs";
import { sha256 } from "./release-manifest.mjs";
import { publishPreparedVersion, recoverVersionPublication } from "./publish-version.mjs";
const setup = async () => {
  const f = await fixture();
  const pointer = await readFile(path.join(f.installationRoot, "current.json"));
  const old = path.join(f.installationRoot, "versions", f.source.currentVersion);
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, "sentinel"), "old-version");
  const observation = {
    status: "app-only-candidate",
    activationAllowed: false,
    sourceVersion: f.source.currentVersion,
    targetVersion: "0.1.0-beta.12",
    sourceComponentVersion: f.source.storageComponentVersion,
    sourceEvidenceSha256: sha256("evidence"),
    sourcePointerSha256: sha256(pointer),
    manifestSha256: f.manifestSha256,
    parentCount: 0,
    remainingGates: ["durable-activation-and-recovery"],
  };
  const observe = async () => ({ ...observation });
  const plan = await createUpdatePlan(
    { ...f, bootstrapperVersion: f.source.bootstrapperVersion, channel: f.source.channel },
    { observe },
  );
  return {
    f,
    pointer,
    observe,
    observation,
    options: {
      installationRoot: f.installationRoot,
      planPath: plan.planPath,
      planSha256: plan.planSha256,
    },
  };
};
const preserved = async (f) => {
  assert.deepEqual(await readFile(path.join(f.f.installationRoot, "current.json")), f.pointer);
  assert.equal(await readFile(path.join(f.f.installationRoot, "user-state"), "utf8"), "preserve");
  assert.equal(
    await readFile(
      path.join(f.f.installationRoot, "versions", f.f.source.currentVersion, "sentinel"),
      "utf8",
    ),
    "old-version",
  );
};
test("publishes the complete version without activating and verifies explicit recovery", async () => {
  const f = await setup();
  const result = await publishPreparedVersion(f.options, { observe: f.observe });
  assert.equal(result.state, "Published");
  assert.equal(result.activationAllowed, false);
  assert.equal(
    await readFile(path.join(result.directory, "desktop/HoneyBee.exe"), "utf8"),
    "desktop",
  );
  assert.equal(
    (
      await recoverVersionPublication(
        { ...f.options, publicationDirectory: result.publicationDirectory },
        { observe: f.observe },
      )
    ).state,
    "Published",
  );
  await assert.rejects(
    publishPreparedVersion(f.options, { observe: f.observe }),
    /Existing version/u,
  );
  await preserved(f);
});
for (const nonempty of [false, true])
  test(`never adopts an existing ${nonempty ? "nonempty" : "empty"} target directory`, async () => {
    const f = await setup(),
      target = path.join(f.f.installationRoot, "versions/0.1.0-beta.12");
    await mkdir(target);
    if (nonempty) await writeFile(path.join(target, "user-file"), "owned");
    await assert.rejects(
      publishPreparedVersion(f.options, { observe: f.observe }),
      /Existing version/u,
    );
    assert.deepEqual(await readdir(target), nonempty ? ["user-file"] : []);
    await preserved(f);
  });
test("copy interruption resumes only its owned version directory", async () => {
  const f = await setup();
  let publicationDirectory;
  await assert.rejects(
    publishPreparedVersion(f.options, {
      observe: f.observe,
      checkpoint: async (state, directory) => {
        publicationDirectory = directory;
        if (state === "copied") throw new Error("copy interrupted");
      },
    }),
  );
  await assert.rejects(
    readFile(path.join(f.f.installationRoot, "versions/0.1.0-beta.12/launch.json")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    publishPreparedVersion(f.options, { observe: f.observe }),
    /Existing version/u,
  );
  await recoverVersionPublication({ ...f.options, publicationDirectory }, { observe: f.observe });
  await preserved(f);
});
test("reservation refuses a destination created after the initial check", async () => {
  const f = await setup(),
    target = path.join(f.f.installationRoot, "versions/0.1.0-beta.12");
  await assert.rejects(
    publishPreparedVersion(f.options, {
      observe: f.observe,
      checkpoint: async (state) => {
        if (state === "before-reserve") await mkdir(target);
      },
    }),
  );
  assert.deepEqual(await readdir(target), []);
  await preserved(f);
});
test("modified copied bytes cannot be recovered or overwritten", async () => {
  const f = await setup();
  let publicationDirectory;
  await assert.rejects(
    publishPreparedVersion(f.options, {
      observe: f.observe,
      checkpoint: async (state, directory) => {
        publicationDirectory = directory;
        if (state === "copied") {
          await writeFile(
            path.join(f.f.installationRoot, "versions/0.1.0-beta.12/cli/dist/cli.js"),
            "changed",
          );
          throw new Error("tampered");
        }
      },
    }),
  );
  await assert.rejects(
    recoverVersionPublication({ ...f.options, publicationDirectory }, { observe: f.observe }),
  );
  await preserved(f);
});
for (const phase of ["reserved", "file-linked", "verified"])
  test(
    `process death at ${phase} resumes without overwriting the version`,
    { timeout: 20000 },
    async (t) => {
      const f = await setup(),
        module = pathToFileURL(path.resolve("scripts/update/publish-version.mjs")).href;
      const script = `import {publishPreparedVersion} from ${JSON.stringify(module)};const input=JSON.parse(process.argv[1]);await publishPreparedVersion(input.options,{observe:async()=>input.observation,checkpoint:async(state,directory)=>{if(state===${JSON.stringify(phase)}){process.stdout.write(directory+'\\n');await new Promise(r=>setTimeout(r,60000));}}});`;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          JSON.stringify({ options: f.options, observation: f.observation }),
        ],
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
          result = await recoverVersionPublication(
            { ...f.options, publicationDirectory: directory },
            { observe: f.observe },
          );
          break;
        } catch (error) {
          if (!/lock unavailable/u.test(error.message) || attempt === 39) throw error;
          await setTimeout(50);
        }
      }
      assert.equal(result.state, "Published");
      await preserved(f);
    },
  );
