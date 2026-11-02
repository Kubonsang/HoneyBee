import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, preserved } from "./prepare-fixture.mjs";
import { sha256 } from "./release-manifest.mjs";
import { createUpdatePlan, revalidateUpdatePlan } from "./update-plan.mjs";
const setup = async () => {
  const options = await fixture();
  const request = {
    ...options,
    bootstrapperVersion: options.source.bootstrapperVersion,
    channel: options.source.channel,
  };
  const observation = {
    status: "app-only-candidate",
    activationAllowed: false,
    sourceVersion: options.source.currentVersion,
    targetVersion: "0.1.0-beta.12",
    sourceComponentVersion: options.source.storageComponentVersion,
    sourceEvidenceSha256: sha256("evidence"),
    sourcePointerSha256: sha256(
      await readFile(path.join(options.installationRoot, "current.json")),
    ),
    manifestSha256: options.manifestSha256,
    parentCount: 3,
    remainingGates: ["durable-activation-and-recovery"],
  };
  const dependencies = { observe: async () => ({ ...observation }) };
  return { options, request, observation, dependencies };
};
test("binds real prepared payload to live observation and revalidates without mutation", async () => {
  const f = await setup();
  const plan = await createUpdatePlan(f.request, f.dependencies);
  const result = await revalidateUpdatePlan(
    { ...plan, installationRoot: f.options.installationRoot },
    f.dependencies,
  );
  assert.equal(result.state, "Revalidated");
  assert.equal(result.activationAllowed, false);
  await preserved(f.options);
});
for (const kind of ["plan", "inventory", "payload", "service", "pointer", "manifest"])
  test(`rejects changed ${kind} after planning`, async () => {
    const f = await setup();
    const plan = await createUpdatePlan(f.request, f.dependencies);
    const attempt = path.dirname(plan.planPath);
    if (kind === "service") f.observation.sourceEvidenceSha256 = sha256("changed");
    else {
      const target = {
        plan: plan.planPath,
        inventory: path.join(attempt, "inventory.json"),
        payload: path.join(attempt, "versions/0.1.0-beta.12/desktop/HoneyBee.exe"),
        pointer: path.join(f.options.installationRoot, "current.json"),
        manifest: path.join(f.options.stageAttempt, "release.json"),
      }[kind];
      await writeFile(target, "changed");
    }
    await assert.rejects(
      revalidateUpdatePlan(
        { ...plan, installationRoot: f.options.installationRoot },
        f.dependencies,
      ),
    );
    assert.equal(
      await readFile(path.join(f.options.installationRoot, "user-state"), "utf8"),
      "preserve",
    );
  });
test("source drift during preparation prevents a durable plan", async () => {
  const f = await setup();
  let calls = 0;
  await assert.rejects(
    createUpdatePlan(f.request, {
      observe: async () => ({ ...f.observation, sourceEvidenceSha256: sha256(String(++calls)) }),
    }),
  );
  const attempts = (await readdir(path.join(f.options.installationRoot, "update"))).filter((name) =>
    name.startsWith("prepare-"),
  );
  assert.equal(attempts.length, 1);
  assert(
    !(await readdir(path.join(f.options.installationRoot, "update", attempts[0]))).includes(
      "plan.json",
    ),
  );
  await preserved(f.options);
});
test("blocked service cannot start package preparation", async () => {
  const f = await setup();
  f.observation.status = "blocked";
  await assert.rejects(createUpdatePlan(f.request, f.dependencies));
  assert(
    !(await readdir(path.join(f.options.installationRoot, "update"))).some((name) =>
      name.startsWith("prepare-"),
    ),
  );
});
test("source drift during revalidation is rejected", async () => {
  const f = await setup();
  const plan = await createUpdatePlan(f.request, f.dependencies);
  let calls = 0;
  await assert.rejects(
    revalidateUpdatePlan(
      { ...plan, installationRoot: f.options.installationRoot },
      { observe: async () => ({ ...f.observation, parentCount: ++calls === 1 ? 3 : 4 }) },
    ),
  );
  await preserved(f.options);
});

const legacySetup = async () => {
  const f = await setup();
  const manifestPath = path.join(f.options.stageAttempt, "release.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.components.storage.migration = {
    kind: "service-replacement",
    supportedSourceVersions: ["0.0.0+cfa606fd4143.hb12"],
  };
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestPath, bytes);
  f.request.manifestSha256 = sha256(bytes);
  f.request.sourceRecovery = "legacy-hb12-detached";
  Object.assign(f.observation, {
    status: "migration-required",
    sourceComponentVersion: "0.0.0+cfa606fd4143.hb12",
    manifestSha256: sha256(bytes),
    sourceRecovery: "legacy-hb12-detached",
  });
  return f;
};

test("pins explicit legacy intent through preparation and both revalidation observations", async () => {
  const f = await legacySetup();
  let calls = 0;
  const dependencies = {
    observe: async (request) => {
      calls++;
      assert.equal(request.sourceRecovery, "legacy-hb12-detached");
      assert.equal(request.installationRoot, f.options.installationRoot);
      return { ...f.observation };
    },
  };
  const plan = await createUpdatePlan(f.request, dependencies);
  const stored = JSON.parse(await readFile(plan.planPath, "utf8"));
  assert.equal(stored.identity.sourceRecovery, "legacy-hb12-detached");
  assert.equal(stored.source.storageComponentVersion, "0.0.0+cfa606fd4143.hb12");
  await revalidateUpdatePlan(
    { ...plan, installationRoot: f.options.installationRoot },
    dependencies,
  );
  assert.equal(calls, 4);
  await preserved(f.options);
});

for (const scenario of ["unsolicited", "missing", "unknown", "ordinary-status", "wrong-version"])
  test(`refuses ${scenario} legacy recovery intent before package preparation`, async () => {
    const f = await legacySetup();
    if (scenario === "unsolicited") delete f.request.sourceRecovery;
    if (scenario === "missing") delete f.observation.sourceRecovery;
    if (scenario === "unknown") f.request.sourceRecovery = "force-replace";
    if (scenario === "ordinary-status") f.observation.status = "app-only-candidate";
    if (scenario === "wrong-version")
      f.observation.sourceComponentVersion = "0.0.0+cfa606fd4143.hb13";
    await assert.rejects(createUpdatePlan(f.request, f.dependencies));
    assert(
      !(await readdir(path.join(f.options.installationRoot, "update"))).some((name) =>
        name.startsWith("prepare-"),
      ),
    );
    await preserved(f.options);
  });

test("refuses legacy intent drift during revalidation without changing the source", async () => {
  const f = await legacySetup();
  const plan = await createUpdatePlan(f.request, f.dependencies);
  delete f.observation.sourceRecovery;
  await assert.rejects(
    revalidateUpdatePlan({ ...plan, installationRoot: f.options.installationRoot }, f.dependencies),
  );
  await preserved(f.options);
});
