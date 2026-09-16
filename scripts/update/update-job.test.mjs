import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { createPrepareJob, createActivationJob } from "./update-job.mjs";
import { dispatchPreparation } from "./dispatch-preparation.mjs";
import { sha256 } from "./release-manifest.mjs";
const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");

for (const outcome of [
  "success",
  "exit-only",
  "wrong-request",
  "wrong-release",
  "changed-pointer",
  "worker-error",
]) {
  test(`Desktop handoff ${outcome} requires bound completion evidence`, async () => {
    const f = await fixture();
    const stage = {
      state: "Verified",
      activationAllowed: false,
      attempt: f.stage,
      version: "0.1.0-beta.12",
      manifestSha256: f.options.manifestSha256,
      signerKeyId: sha256("key"),
    };
    const prepare = dispatchPreparation(
      { installationRoot: f.root, stage },
      {
        run: async (executable, args) => {
          assert.equal(executable, path.join(f.root, "HoneyBeeLauncher.exe"));
          assert.equal(args[0], "--update-job");
          if (outcome === "worker-error") throw new Error("worker rejected");
          if (outcome === "exit-only") return;
          const directory = path.join(f.root, "update/jobs", args[1]);
          const result = {
            schemaVersion: 1,
            passed: true,
            requestSha256: outcome === "wrong-request" ? sha256("other") : args[2],
            result: {
              schemaVersion: 1,
              state: "ReadyForActivation",
              activationAllowed: false,
              version: stage.version,
              manifestSha256: outcome === "wrong-release" ? sha256("other") : stage.manifestSha256,
              signerKeyId: stage.signerKeyId,
              stageAttempt: stage.attempt,
              sourcePointerSha256: sha256(f.pointer),
            },
          };
          await writeFile(path.join(directory, "result.json"), JSON.stringify(result));
          if (outcome === "changed-pointer")
            await writeFile(path.join(f.root, "current.json"), "changed");
        },
      },
    );
    if (outcome === "success") await prepare;
    else await assert.rejects(prepare);
    if (outcome !== "changed-pointer")
      assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
  });
}
async function fixture() {
  const parent = path.join(repository, "output/update-job-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const stage = path.join(root, "update/stage-ABC123");
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, "release.json"), "{}");
  const pointer = JSON.stringify({
    activeVersion: "0.1.0-beta.11",
    manifestSha256: sha256("launch"),
  });
  await writeFile(path.join(root, "current.json"), pointer);
  const options = { installationRoot: root, stageAttempt: stage, manifestSha256: sha256("{}") };
  return { root, stage, pointer, options };
}
async function workerFixture() {
  const f = await fixture();
  const runtime = path.join(f.root, "recovery/v1");
  await cp(path.join(repository, "scripts/update"), path.join(runtime, "scripts/update"), {
    recursive: true,
  });
  await cp(path.join(repository, "packages/core/dist"), path.join(runtime, "packages/core/dist"), {
    recursive: true,
  });
  await cp(
    path.join(repository, "packages/core/package.json"),
    path.join(runtime, "packages/core/package.json"),
  );
  const job = await createPrepareJob(f.options);
  const invoke = () =>
    run(process.execPath, [
      path.join(runtime, "scripts/update/worker.mjs"),
      f.root,
      job.name,
      job.sha256,
    ]);
  return { ...f, runtime, job, invoke };
}

for (const setupActivation of [false, true])
  test(`independent ${setupActivation ? "Setup" : "Desktop"} activation worker records missing preparation evidence without switching`, async () => {
    const f = await workerFixture();
    await writeFile(path.join(f.root, "HoneyBeeLauncher.exe"), "fixture launcher");
    const activation = await createActivationJob({
      installationRoot: f.root,
      preparation: f.job,
      ...(setupActivation
        ? { setupActivation: true }
        : {
            desktopDescriptor: path.join(
              f.root,
              "update/desktop-sessions/11111111-1111-1111-1111-111111111111.json",
            ),
          }),
    });
    await assert.rejects(
      run(process.execPath, [
        path.join(f.runtime, "scripts/update/worker.mjs"),
        f.root,
        activation.name,
        activation.sha256,
      ]),
    );
    const result = JSON.parse(await readFile(path.join(activation.directory, "result.json")));
    assert.equal(result.passed, false);
    assert.equal(result.requestSha256, activation.sha256);
    assert.match(result.error, /ENOENT/);
    assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
  });
test("prepare requests pin stage and source without changing the active pointer", async () => {
  const f = await fixture();
  const first = await createPrepareJob(f.options),
    second = await createPrepareJob(f.options);
  assert.notEqual(first.name, second.name);
  const bytes = await readFile(path.join(first.directory, "request.json"));
  assert.equal(sha256(bytes), first.sha256);
  assert.equal(JSON.parse(bytes).sourcePointerSha256, sha256(f.pointer));
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});
test("request creation refuses external stage and changed metadata", async () => {
  const f = await fixture();
  await assert.rejects(
    createPrepareJob({ ...f.options, stageAttempt: path.join(f.root, "stage-ABC123") }),
  );
  await assert.rejects(createPrepareJob({ ...f.options, manifestSha256: sha256("changed") }));
});
test("independent worker records a changed source failure and refuses replay", async () => {
  const f = await workerFixture();
  await writeFile(path.join(f.root, "current.json"), "changed source");
  await assert.rejects(f.invoke());
  const resultPath = path.join(f.job.directory, "result.json");
  const bytes = await readFile(resultPath, "utf8");
  const result = JSON.parse(bytes);
  assert.equal(result.passed, false);
  assert.match(result.error, /Active source changed/);
  await assert.rejects(f.invoke());
  assert.equal(await readFile(resultPath, "utf8"), bytes);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), "changed source");
});
test("independent worker refuses a source without approved recovery", async () => {
  const f = await workerFixture();
  await writeFile(
    path.join(f.runtime, "approved-source.json"),
    JSON.stringify({ schemaVersion: 1, version: "0.1.0-beta.10" }),
  );
  await assert.rejects(f.invoke());
  const result = JSON.parse(await readFile(path.join(f.job.directory, "result.json")));
  assert.match(result.error, /ENOENT|no approved automatic recovery path/);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});
test("independent worker refuses tampered job before claiming it", async () => {
  const f = await workerFixture();
  await writeFile(path.join(f.job.directory, "request.json"), "{}");
  await assert.rejects(f.invoke());
  await assert.rejects(readFile(path.join(f.job.directory, "started.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});

test("independent worker refuses changed approved recovery payload", async () => {
  const f = await workerFixture();
  const source = path.join(f.root, "versions/0.1.0-beta.11");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "launch.json"), "changed");
  await writeFile(
    path.join(f.runtime, "approved-source.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0-beta.11",
      launchSha256: sha256("launch"),
      files: { "launch.json": sha256("launch") },
    }),
  );
  await assert.rejects(f.invoke());
  const result = JSON.parse(await readFile(path.join(f.job.directory, "result.json")));
  assert.match(result.error, /Recovery source payload changed/);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});
