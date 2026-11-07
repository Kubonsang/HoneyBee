import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createEmbeddedReleaseTransport,
  authorizeMatchingSetup,
  authorizeSetupRuntime,
  runExternalSetupJob,
  resumeLegacySetupUpgrade,
  findReusableLegacyPreparation,
} from "./setup-upgrade.mjs";
import { signReleaseManifest } from "./release-authentication.mjs";
import { stageAuthenticatedRelease } from "./authenticated-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import {
  combinedUpdateIdentity,
  inspectCombinedJournal,
  readCombinedOutcome,
} from "./combined-update.mjs";
import { persistCombinedApplicationContext } from "./combined-application.mjs";

for (const scenario of [
  "valid",
  "other-source",
  "other-release",
  "failed-job",
  "changed-request",
  "changed-plan",
  "ordinary-plan",
]) {
  test(`legacy Setup reuses only a fully bound preparation: ${scenario}`, async () => {
    const parent = path.resolve("output/setup-media-tests");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, "reuse-"));
    const job = path.join(root, "update/jobs/job-reuse123"),
      attempt = path.join(root, "update/prepare-reuse123");
    await mkdir(job, { recursive: true });
    await mkdir(attempt, { recursive: true });
    const options = {
      installationRoot: root,
      manifestSha256: "a".repeat(64),
      sourcePointerSha256: "b".repeat(64),
    };
    const request = {
      schemaVersion: 1,
      operation: "prepare",
      manifestSha256: scenario === "other-release" ? "c".repeat(64) : options.manifestSha256,
      sourcePointerSha256:
        scenario === "other-source" ? "c".repeat(64) : options.sourcePointerSha256,
    };
    const requestBytes = Buffer.from(JSON.stringify(request));
    await writeFile(path.join(job, "request.json"), requestBytes);
    const planPath = path.join(attempt, "plan.json");
    const plan = {
      identity: {
        sourceRecovery: scenario === "ordinary-plan" ? undefined : "legacy-hb12-detached",
        sourceComponentVersion: "0.0.0+cfa606fd4143.hb12",
        sourcePointerSha256: options.sourcePointerSha256,
        manifestSha256: options.manifestSha256,
      },
    };
    const planBytes = Buffer.from(JSON.stringify(plan));
    await writeFile(planPath, planBytes);
    const result = {
      state: "ReadyForActivation",
      activationAllowed: false,
      manifestSha256: options.manifestSha256,
      sourcePointerSha256: options.sourcePointerSha256,
      planPath,
      planSha256: sha256(planBytes),
      publicationDirectory: path.join(root, "update/publications/publish-reuse123"),
    };
    await writeFile(
      path.join(job, "result.json"),
      JSON.stringify({
        schemaVersion: 1,
        passed: scenario !== "failed-job",
        requestSha256: sha256(requestBytes),
        result,
      }),
    );
    if (scenario === "changed-request")
      await writeFile(
        path.join(job, "request.json"),
        JSON.stringify({ ...request, extra: "changed" }),
      );
    if (scenario === "changed-plan") await writeFile(planPath, "changed");
    let calls = 0;
    const operation = findReusableLegacyPreparation(options, {
      revalidate: async (value) => {
        calls++;
        assert.equal(value.planSha256, sha256(planBytes));
        assert.equal(value.installationRoot, root);
      },
      verify: async (value) => {
        calls++;
        assert.equal(value.allowServiceCandidate, true);
        assert.equal(value.publicationDirectory, result.publicationDirectory);
      },
    });
    if (["changed-request", "changed-plan"].includes(scenario)) await assert.rejects(operation);
    else {
      const found = await operation;
      assert.deepEqual(
        found,
        scenario === "valid" ? { name: "job-reuse123", sha256: sha256(requestBytes) } : undefined,
      );
    }
    assert.equal(calls, scenario === "valid" ? 2 : 0);
  });
}

test("rerunning Setup without a legacy journal does not create update state", async () => {
  const parent = path.resolve("output/setup-media-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "no-recovery-"));
  assert.equal(await resumeLegacySetupUpgrade({ installationRoot: root }), undefined);
  await assert.rejects(readFile(path.join(root, "update/combined")), { code: "ENOENT" });
});

for (const scenario of ["cancelled-consent", "other-setup", "multiple", "empty"]) {
  test(`interrupted legacy Setup admission refuses before authentication: ${scenario}`, async () => {
    const parent = path.resolve("output/setup-media-tests");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, "pending-"));
    const source = {
      schemaVersion: 1,
      generation: 1,
      activeVersion: "0.1.0-beta.35",
      manifestSha256: "272b131a2d3deaffedee07f94e904f9ec1d822d868b8eb2494b60576f947b2cb",
    };
    const sourceBytes = Buffer.from(JSON.stringify(source));
    await writeFile(path.join(root, "current.json"), sourceBytes);
    for (let i = 0; i < (scenario === "multiple" ? 2 : 1); i++) {
      const identity = {
        manifestSha256: "a".repeat(64),
        sourcePointerSha256: sha256(sourceBytes),
        serviceTransactionSha256: sha256("service-" + i),
      };
      const id = combinedUpdateIdentity(identity);
      await persistCombinedApplicationContext(root, {
        schemaVersion: 1,
        identity,
        identitySha256: id,
        sourcePointer: sourceBytes.toString("base64"),
        targetPointer: Buffer.from(
          JSON.stringify({ ...source, generation: 2, activeVersion: "0.1.0-beta.38" }),
        ).toString("base64"),
        launcherSha256: "b".repeat(64),
        nativeCoordinator: "target",
        sourceRecovery: "legacy-hb12-detached",
        sourceObservationSha256: "c".repeat(64),
      });
      const directory = path.join(root, "update/combined", id);
      await mkdir(directory, { recursive: true });
      if (scenario !== "empty")
        await writeFile(
          path.join(directory, "01.json"),
          JSON.stringify({
            schemaVersion: 1,
            identitySha256: id,
            previousSha256: id,
            state: "Prepared",
          }),
        );
      if (scenario === "empty") {
        const options = {
          installationRoot: root,
          transactionDirectory: directory,
          sourcePointerSha256: identity.sourcePointerSha256,
        };
        assert.equal((await inspectCombinedJournal(options)).state, "Unrecorded");
        await assert.rejects(readCombinedOutcome(options));
      }
    }
    await assert.rejects(
      resumeLegacySetupUpgrade({
        installationRoot: root,
        expectedVersion: scenario === "other-setup" ? "0.1.0-beta.39" : "0.1.0-beta.38",
        allowServiceUpdate: scenario === "other-setup" || scenario === "multiple",
      }),
      scenario === "other-setup"
        ? /matching Setup/u
        : scenario === "multiple"
          ? /Multiple interrupted/u
          : /interactive Setup/u,
    );
    assert.deepEqual(await readFile(path.join(root, "current.json")), sourceBytes);
  });
}

for (const scenario of ["success", "failure", "changed-before", "changed-during"]) {
  test(`external Setup job retains bound completion evidence: ${scenario}`, async () => {
    const parent = path.resolve("output/setup-media-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "job-"));
    const request = Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "setup-activate" }));
    const requestPath = path.join(directory, "request.json");
    await writeFile(requestPath, request);
    const job = { directory, sha256: sha256(request) };
    if (scenario === "changed-before") await writeFile(requestPath, "changed");
    let calls = 0;
    const operation = runExternalSetupJob(job, async () => {
      calls++;
      if (scenario === "failure") throw Error("native operation refused");
      if (scenario === "changed-during") await writeFile(requestPath, "changed");
      return { state: "Cancelled" };
    });
    if (scenario === "success") assert.equal((await operation).state, "Cancelled");
    else await assert.rejects(operation);
    assert.equal(calls, scenario === "changed-before" ? 0 : 1);
    if (scenario !== "changed-before") {
      const receipt = JSON.parse(await readFile(path.join(directory, "result.json")));
      assert.equal(receipt.requestSha256, job.sha256);
      assert.equal(receipt.passed, scenario === "success");
    }
    await assert.rejects(
      runExternalSetupJob(job, () => assert.fail("job replay must never execute")),
    );
  });
}

test("later matching Setup repairs only the approved app while retaining original infrastructure", async () => {
  const parent = path.resolve("output/setup-media-tests");
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(path.join(parent, "repair-")),
    root = path.join(base, "installed"),
    source = path.join(base, "setup");
  const version = "0.1.0-beta.12",
    files = {
      "launch.json": "launch",
      "installation.json": JSON.stringify({ activity: { protocol: 1 } }),
      "desktop/app": "original app",
    };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, "versions", version, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const pointer = JSON.stringify({
    schemaVersion: 1,
    generation: 2,
    activeVersion: version,
    manifestSha256: sha256("launch"),
  });
  await writeFile(path.join(root, "current.json"), pointer);
  await cp(root, source, { recursive: true });
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, ".setup-pending"));
  const inventory = {};
  for (const name of ["HoneyBeeLauncher.exe", "bin/honeybee.exe"]) {
    await writeFile(path.join(root, name), name);
    inventory[name] = sha256(name);
  }
  await writeFile(
    path.join(root, ".setup-pending/prepared.json"),
    JSON.stringify({ schemaVersion: 1, inventory }),
  );
  const runtime = path.join(root, "recovery/v1");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "manifest.json"), "runtime manifest");
  await writeFile(
    path.join(runtime, "approved-source.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      launchSha256: sha256("launch"),
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]),
      ),
    }),
  );
  const run = async (_exe, args) => {
    assert.deepEqual(args, ["--verify-recovery-runtime"]);
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        recoveryManifestSha256: sha256("runtime manifest"),
      }),
    };
  };
  const options = { installationRoot: root, sourceInstallation: source };
  await assert.rejects(
    authorizeSetupRuntime(root, {
      run: async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          recoveryManifestSha256: sha256("other runtime"),
        }),
      }),
    }),
  );
  await assert.rejects(
    authorizeSetupRuntime(root, {
      run: async () => {
        throw new Error("runtime verification failed");
      },
    }),
    /runtime verification failed/,
  );
  assert.equal((await authorizeSetupRuntime(root, { run })).runtime, runtime);
  assert.equal((await authorizeMatchingSetup(options, { run })).runtime, runtime);
  await writeFile(path.join(root, "versions", version, "desktop/app"), "damaged app");
  await assert.rejects(authorizeMatchingSetup(options, { run }), /payload changed/);
  await authorizeMatchingSetup({ ...options, verifyActive: false }, { run });
  await writeFile(path.join(root, "bin/honeybee.exe"), "damaged shim");
  await assert.rejects(
    authorizeMatchingSetup({ ...options, verifyActive: false }, { run }),
    /bootstrapper or shim/,
  );
  assert.equal(await readFile(path.join(root, "current.json"), "utf8"), pointer);
});

test("embedded Setup media uses release signature and streaming package verification", async () => {
  const parent = path.resolve("output/setup-media-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const media = path.join(root, "media"),
    installationRoot = path.join(root, "installed");
  await mkdir(media);
  await mkdir(installationRoot);
  const pointer = Buffer.from("preserved active pointer");
  await writeFile(path.join(installationRoot, "current.json"), pointer);
  const keys = generateKeyPairSync("ed25519"),
    payload = Buffer.from("fixture archive; never executed");
  const manifest = {
    schemaVersion: 1,
    version: "0.1.0-beta.13",
    channel: "beta",
    mandatory: false,
    minimumSourceVersion: "0.1.0-beta.12",
    minimumBootstrapperVersion: "1.0.0",
    packages: {
      application: {
        url: "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.13/application.zip",
        sha256: sha256(payload),
        size: payload.length,
        format: "zip",
      },
    },
    components: {
      desktop: { version: "0.1.0-beta.13", package: "application" },
      cli: { version: "0.1.0-beta.13", package: "application" },
      storage: {
        componentVersion: "test.hb13",
        package: "application",
        migration: { kind: "none", supportedSourceVersions: ["test.hb13"] },
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(media, "release.json"), bytes);
  await writeFile(
    path.join(media, "release.sig.json"),
    signReleaseManifest(bytes, keys.privateKey),
  );
  await writeFile(path.join(media, "application.zip"), payload);
  await assert.rejects(
    createEmbeddedReleaseTransport(media, [generateKeyPairSync("ed25519").publicKey]),
  );
  const transport = await createEmbeddedReleaseTransport(media, [keys.publicKey]);
  await assert.rejects(transport.fetchImpl("https://example.com/unrelated"));
  const options = {
    installationRoot,
    ...transport,
    trustedPublicKeys: [keys.publicKey],
    source: {
      currentVersion: "0.1.0-beta.12",
      bootstrapperVersion: "1.0.0",
      channel: "beta",
      storageComponentVersion: "test.hb13",
    },
    signal: globalThis.AbortSignal.timeout(30000),
  };
  const staged = await stageAuthenticatedRelease(options);
  assert.equal(staged.state, "Verified");
  assert.deepEqual(await readFile(path.join(staged.attempt, "application.zip")), payload);
  await writeFile(path.join(media, "application.zip"), Buffer.alloc(payload.length));
  await assert.rejects(stageAuthenticatedRelease(options), /staging failed/);
  assert.deepEqual(await readFile(path.join(installationRoot, "current.json")), pointer);
});
