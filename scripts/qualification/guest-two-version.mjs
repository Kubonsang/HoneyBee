import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile, lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { createHash } from "node:crypto";
import { stageRelease, plainDirectory } from "../update/stage-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { createUpdatePlan } from "../update/update-plan.mjs";
import { publishPreparedVersion, verifyPublishedVersion } from "../update/publish-version.mjs";
import {
  activatePublishedUpdateWithDoctor,
  recoverPublishedUpdateWithDoctor,
} from "../update/doctor-update.mjs";
import { checkVersionHealth, runDoctorProcess } from "../update/version-health.mjs";
import { readEmptyQARegistry } from "./qa-registry.mjs";
import { runDesktopUpdateScenario } from "./desktop-update-scenario.mjs";
import { withApplicationActivity } from "../update/application-activity.mjs";
const bundle = path.resolve(import.meta.dirname, "../..");
const pin = JSON.parse(await readFile(path.join(bundle, "qualification.json")));
assert.equal(os.hostname(), pin.computerName, "Wrong QA computer");
const installed = path.join(process.env.LOCALAPPDATA, "HoneyBee");
const sourceInstallation = pin.desktopLifecycle ? path.join(bundle, "source") : installed;
const durableRecord = async (file, value) => {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const digest = async (file) => {
  await plainDirectory(path.dirname(file));
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink());
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
};
assert.equal(await digest(path.join(bundle, "inventory.json")), pin.inventorySha256);
assert.equal(
  await digest(path.join(bundle, "output/update-tools/honeybee-update-package.exe")),
  pin.helperSha256,
);
const inventory = JSON.parse(await readFile(path.join(bundle, "inventory.json")));
for (const name of Object.keys(inventory))
  assert(
    !name.includes("\\") &&
      !name.includes(":") &&
      name.split("/").every((p) => p && p !== "." && p !== ".."),
  );
const verifySource = async (root) => {
  for (const [name, hash] of Object.entries(inventory))
    if (name.startsWith("versions/"))
      assert.equal(await digest(path.join(root, name)), hash, `Source changed: ${name}`);
};
const receiptPath = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/install-receipt.json",
);
const broker = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/broker/unity-workspace-storage-host.exe",
);
const registry = path.join(installed, "workspace-core/workspace-registry-v2.json");
const watched = [
  path.join(installed, "current.json"),
  registry,
  receiptPath,
  path.join(process.env.ProgramData, "UnityWorkspaceStorage/broker-config.json"),
  broker,
];
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      watched.map(async (file) => [
        file,
        file === registry ? (await readEmptyQARegistry(file)).digest : await digest(file),
      ]),
    ),
  );
const checkGuest = async (baseline) => {
  assert.deepEqual(await snapshot(), baseline, "Original installation/user/service state changed");
  const receipt = JSON.parse(await readFile(receiptPath));
  assert.equal(receipt.userSid, pin.userSid);
  assert.equal(receipt.executableSha256, pin.controlSha256);
  assert.equal(baseline[broker], pin.controlSha256);
  assert.equal(
    (await readEmptyQARegistry(registry)).digest,
    baseline[registry],
    "Registry changed during admission",
  );
};
const hooksFor = async (config) => {
  assert.equal(
    path.dirname(config.options.installationRoot),
    path.join(bundle, "Cases"),
    "Case outside bundle",
  );
  assert(/^case-[A-Za-z0-9]+$/u.test(path.basename(config.options.installationRoot)));
  await plainDirectory(config.options.installationRoot);
  const planBytes = await readFile(config.options.planPath);
  assert.equal(sha256(planBytes), config.options.planSha256);
  const plan = JSON.parse(planBytes);
  let phase;
  return {
    observe: async () => {
      await checkGuest(config.baseline);
      return { ...plan.identity, activationAllowed: false, remainingGates: plan.remainingGates };
    },
    admit: async () => {
      await checkGuest(config.baseline);
      await verifySource(config.options.installationRoot);
      return true;
    },
    authorizeHealth: async (context) => {
      phase = context.phase;
      await checkGuest(config.baseline);
      if (context.version === pin.version) await verifySource(config.options.installationRoot);
      else {
        assert.equal(context.version, pin.targetVersion);
        await verifyPublishedVersion(config.options);
      }
      return true;
    },
    runDoctor: async (request) => {
      const result = await runDoctorProcess(request);
      if (config.mode === "rollback" && phase === "target-after-switch")
        throw new Error("QA injected post-switch health failure after real Doctor");
      return result;
    },
    checkpoint: async (state, directory) => {
      if (["crash", "reboot"].includes(config.mode) && state === "switched") {
        await durableRecord(path.join(config.options.installationRoot, "crash-journal.json"), {
          directory,
        });
        if (config.mode === "reboot") {
          assert(process.env.HONEYBEE_QA_BOOT_ID, "Windows boot identity required");
          const configPath = path.join(config.options.installationRoot, "scenario.json");
          await durableRecord(path.join(bundle, "reboot-pending.json"), {
            configPath,
            configSha256: sha256(await readFile(configPath)),
            bootId: process.env.HONEYBEE_QA_BOOT_ID,
          });
        }
        process.stdout.write(directory + "\n");
        await new Promise(() => {});
      }
    },
  };
};
if (process.argv[2] === "--child") {
  const configPath = path.resolve(process.argv[3]);
  assert.equal(path.basename(configPath), "scenario.json");
  assert.equal(path.dirname(path.dirname(configPath)), path.join(bundle, "Cases"));
  const config = JSON.parse(await readFile(configPath));
  if (pin.desktopLifecycle) await runDesktopUpdateScenario(config, await hooksFor(config), pin);
  else await activatePublishedUpdateWithDoctor(config.options, await hooksFor(config));
} else if (
  pin.interruption &&
  (await lstat(path.join(bundle, "reboot-pending.json")).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  ))
) {
  const pending = JSON.parse(await readFile(path.join(bundle, "reboot-pending.json")));
  assert(
    process.env.HONEYBEE_QA_BOOT_ID && process.env.HONEYBEE_QA_BOOT_ID !== pending.bootId,
    "Restart Windows INSIDE THE QA VM, then run this same QA command again",
  );
  const configPath = path.resolve(pending.configPath);
  assert.equal(path.basename(configPath), "scenario.json");
  assert.equal(path.dirname(path.dirname(configPath)), path.join(bundle, "Cases"));
  const bytes = await readFile(configPath);
  assert.equal(sha256(bytes), pending.configSha256);
  const config = JSON.parse(bytes);
  assert.equal(config.mode, "reboot");
  assert.equal(path.resolve(config.options.installationRoot), path.dirname(configPath));
  await checkGuest(config.baseline);
  config.options.transactionDirectory = JSON.parse(
    await readFile(path.join(path.dirname(configPath), "crash-journal.json")),
  ).directory;
  if (pin.startupRecovery) {
    const root = config.options.installationRoot;
    if (pin.setupSource) {
      assert.equal(config.setupSha256, pin.setupSha256, "Resume Setup binding changed");
      assert.equal(config.setupInventorySha256, pin.setupInventorySha256);
      assert.equal(
        await digest(path.join(root, "setup-source-result.json")),
        config.setupEvidenceSha256,
      );
      const setupEvidence = JSON.parse(await readFile(path.join(root, "setup-source-result.json")));
      assert.equal(setupEvidence.setupSha256, pin.setupSha256);
      assert.equal(setupEvidence.health.ready, true);
      assert.equal(setupEvidence.health.serviceAction, "none");
    }
    const desktop = await runDesktopUpdateScenario(
      { ...config, mode: "recovery-only" },
      await hooksFor(config),
      pin,
    );
    assert.deepEqual(
      await readFile(path.join(root, "current.json")),
      await readFile(path.join(sourceInstallation, "current.json")),
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(config.options.transactionDirectory, "RolledBack.state.json")),
      ).state,
      "RolledBack",
    );
    const attempts = path.join(root, "update/recovery-attempts");
    const records = (await readdir(attempts)).sort();
    const reports = await Promise.all(
      records.map(async (name) =>
        JSON.parse(await readFile(path.join(attempts, name, "result.json"))),
      ),
    );
    assert(
      reports.some(
        (report) =>
          report.passed === true &&
          report.healthChecks.length >= 2 &&
          report.healthChecks.every((health) => health.ready === true),
      ),
      "Automatic recovery Doctor evidence missing",
    );
    const repeated = await promisify(execFile)(path.join(root, "bin/honeybee.exe"), ["--version"], {
      cwd: root,
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal(repeated.stdout.trim(), pin.version);
    assert.deepEqual((await readdir(attempts)).sort(), records, "Repeat launch reran recovery");
    await verifySource(root);
    await verifyPublishedVersion(config.options);
    await checkGuest(config.baseline);
    await writeFile(
      path.join(bundle, "startup-reboot-result.json"),
      JSON.stringify(
        {
          passed: true,
          automatic: true,
          desktop,
          repeatedLaunch: true,
          preserved: true,
          bootId: process.env.HONEYBEE_QA_BOOT_ID,
          previousBootId: pending.bootId,
          ...(pin.setupSource ? { setupSource: true, setupSha256: pin.setupSha256 } : {}),
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      "Automatic startup recovery after reboot PASSED; retain startup-reboot-result.json and Cases\n",
    );
    if (pin.setupSource) process.stdout.write("Setup-installed recovery after reboot PASSED\n");
  } else {
    const result = await withApplicationActivity(
      { installationRoot: config.options.installationRoot, mode: "exclusive", timeoutMs: 30000 },
      async () => recoverPublishedUpdateWithDoctor(config.options, await hooksFor(config)),
    );
    assert.equal(result.state, "RolledBack");
    assert.deepEqual(
      await readFile(path.join(config.options.installationRoot, "current.json")),
      await readFile(path.join(sourceInstallation, "current.json")),
    );
    const desktop = await runDesktopUpdateScenario(
      { ...config, mode: "recovery-only" },
      await hooksFor(config),
      pin,
    );
    await verifySource(config.options.installationRoot);
    await verifyPublishedVersion(config.options);
    await checkGuest(config.baseline);
    const repeated = await withApplicationActivity(
      { installationRoot: config.options.installationRoot, mode: "exclusive", timeoutMs: 30000 },
      async () => recoverPublishedUpdateWithDoctor(config.options, await hooksFor(config)),
    );
    assert.equal(repeated.state, "RolledBack");
    await writeFile(
      path.join(bundle, "reboot-result.json"),
      JSON.stringify({ passed: true, result, repeated, desktop, preserved: true }, null, 2),
    );
    process.stdout.write("Reboot recovery PASSED; retain reboot-result.json and Cases\n");
  }
} else {
  const baseline = await snapshot();
  await checkGuest(baseline);
  await verifySource(sourceInstallation);
  assert.equal(await digest(path.join(bundle, "application.zip")), pin.targetZipSha256);
  const manifestBytes = await readFile(path.join(bundle, "release.json"));
  assert.equal(sha256(manifestBytes), pin.targetManifestSha256);
  const pointer = await readFile(path.join(sourceInstallation, "current.json"));
  assert.equal(sha256(pointer), inventory["current.json"]);
  const health = await checkVersionHealth(
    {
      installationRoot: sourceInstallation,
      version: pin.version,
      launchManifestSha256: pin.launchSha256,
    },
    {
      authorize: async () => {
        await checkGuest(baseline);
        await verifySource(sourceInstallation);
        return true;
      },
    },
  );
  assert.equal(health.ready, true, "Original installation Doctor failed");
  assert.match(
    health.report.checks.find((c) => c.code === "storage.status").message,
    /\b0 parent\(s\)/u,
    "QA requires empty storage parents",
  );
  const cases = path.join(bundle, "Cases");
  await mkdir(cases, { recursive: true });
  const results = [];
  for (const mode of pin.startupRecovery
    ? [pin.startupReboot ? "reboot" : "crash"]
    : pin.interruption
      ? ["crash", "reboot"]
      : pin.desktopLifecycle
        ? ["commit", "rollback", "cancel", "restart-failure"]
        : ["commit", "rollback", "crash"]) {
    const root = await mkdtemp(path.join(cases, "case-"));
    process.stdout.write("Scenario " + mode + ": " + root + "\n");
    try {
      if (pin.setupSource) {
        const { installSetupSource } = await import("./setup-source.mjs");
        assert(pin.startupRecovery && pin.desktopLifecycle);
        const setupResult = await installSetupSource({ bundle, target: root, pin });
        await durableRecord(path.join(root, "setup-source-result.json"), setupResult);
        await checkGuest(baseline);
        assert.deepEqual(await readFile(path.join(root, "current.json")), pointer);
        await verifySource(root);
        assert.equal(await digest(path.join(root, "HoneyBeeLauncher.exe")), pin.launcherSha256);
        assert.equal(await digest(path.join(root, "bin/honeybee.exe")), pin.shimSha256);
        assert.equal(
          await digest(path.join(root, "recovery/v1/manifest.json")),
          pin.recoveryManifestSha256,
        );
      } else {
        for (const name of Object.keys(inventory))
          if (name.startsWith("versions/")) {
            await mkdir(path.dirname(path.join(root, name)), { recursive: true });
            await cp(path.join(sourceInstallation, name), path.join(root, name), {
              errorOnExist: true,
              force: false,
            });
          }
        await writeFile(path.join(root, "current.json"), pointer, { flag: "wx" });
        if (pin.desktopLifecycle) {
          assert.equal(
            await digest(path.join(sourceInstallation, "HoneyBeeLauncher.exe")),
            pin.launcherSha256,
          );
          await cp(
            path.join(sourceInstallation, "HoneyBeeLauncher.exe"),
            path.join(root, "HoneyBeeLauncher.exe"),
            { errorOnExist: true, force: false },
          );
        }
        if (pin.startupRecovery) {
          await cp(path.join(sourceInstallation, "recovery"), path.join(root, "recovery"), {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
          await mkdir(path.join(root, "bin"));
          assert.equal(
            await digest(path.join(sourceInstallation, "bin/honeybee.exe")),
            pin.shimSha256,
          );
          await cp(
            path.join(sourceInstallation, "bin/honeybee.exe"),
            path.join(root, "bin/honeybee.exe"),
            { force: false, errorOnExist: true },
          );
          assert.equal(
            await digest(path.join(root, "recovery/v1/manifest.json")),
            pin.recoveryManifestSha256,
          );
        }
      }
      const source = {
        currentVersion: pin.version,
        bootstrapperVersion: "1.0.0",
        channel: "beta",
        storageComponentVersion: pin.componentVersion,
      };
      const staged = await stageRelease({
        installationRoot: root,
        manifestBytes,
        manifestSha256: pin.targetManifestSha256,
        source,
        fetchImpl: async () =>
          new globalThis.Response(
            Readable.toWeb(createReadStream(path.join(bundle, "application.zip"))),
          ),
      });
      // QA-only fixed baseline adapter. This is not the production service-evidence protocol.
      const observation = {
        status: "app-only-candidate",
        activationAllowed: false,
        sourceVersion: pin.version,
        targetVersion: pin.targetVersion,
        sourceComponentVersion: pin.componentVersion,
        sourceEvidenceSha256: sha256(JSON.stringify(baseline)),
        sourcePointerSha256: sha256(pointer),
        manifestSha256: pin.targetManifestSha256,
        parentCount: 0,
        remainingGates: ["QA-only-baseline-observer", "production-admission-and-quiescence"],
      };
      const observe = async () => {
        await checkGuest(baseline);
        return { ...observation };
      };
      const plan = await createUpdatePlan(
        {
          installationRoot: root,
          stageAttempt: staged.attempt,
          manifestSha256: pin.targetManifestSha256,
          bootstrapperVersion: "1.0.0",
          channel: "beta",
        },
        { observe },
      );
      const options = {
        installationRoot: root,
        planPath: plan.planPath,
        planSha256: plan.planSha256,
      };
      const publication = await publishPreparedVersion(options, { observe });
      options.publicationDirectory = publication.publicationDirectory;
      const config = { mode, baseline, options };
      if (pin.setupSource) {
        config.setupSha256 = pin.setupSha256;
        config.setupInventorySha256 = pin.setupInventorySha256;
        config.setupEvidenceSha256 = await digest(path.join(root, "setup-source-result.json"));
      }
      const configPath = path.join(root, "scenario.json");
      await durableRecord(configPath, config);
      let result;
      if (pin.desktopLifecycle && !["crash", "reboot"].includes(mode))
        result = await runDesktopUpdateScenario(config, await hooksFor(config), pin);
      else if (["crash", "reboot"].includes(mode)) {
        const child = spawn(process.execPath, [process.argv[1], "--child", configPath], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (b) => {
          stderr = (stderr + b).slice(-65536);
        });
        const exited = once(child, "exit");
        let timer;
        try {
          await Promise.race([
            once(child.stdout, "data"),
            exited.then(() => {
              throw new Error(stderr);
            }),
            new Promise((_, reject) => {
              timer = globalThis.setTimeout(
                () => reject(new Error("Crash checkpoint timeout")),
                180000,
              );
            }),
          ]);
          if (mode === "reboot") {
            process.stdout.write(
              "REBOOT CHECKPOINT READY. Restart Windows INSIDE THIS QA VM, then run the SAME QA command again. Do not reboot the host.\n",
            );
            await new Promise(() => {});
          }
          child.kill();
          await exited;
        } finally {
          globalThis.clearTimeout(timer);
          child.kill();
        }
        options.transactionDirectory = JSON.parse(
          await readFile(path.join(root, "crash-journal.json")),
        ).directory;
        if (pin.startupRecovery) {
          const before = await readFile(path.join(root, "current.json"));
          const refusals = [];
          for (const relative of [
            "recovery/v1/scripts/recovery/startup.mjs",
            `versions/${pin.version}/cli/dist/cli.js`,
          ]) {
            const file = path.join(root, relative);
            const original = await readFile(file);
            try {
              await writeFile(file, Buffer.concat([original, Buffer.from("\n// QA tamper\n")]));
              await assert.rejects(
                promisify(execFile)(path.join(root, "bin/honeybee.exe"), ["--version"], {
                  cwd: root,
                  windowsHide: true,
                  timeout: 180000,
                }),
                (error) => Number.isInteger(error.code) && error.code !== 0 && !error.killed,
              );
              assert.deepEqual(await readFile(path.join(root, "current.json")), before);
              refusals.push(relative);
            } finally {
              await writeFile(file, original);
            }
          }
          const desktop = await runDesktopUpdateScenario(
            { ...config, mode: "recovery-only" },
            await hooksFor(config),
            pin,
          );
          assert.deepEqual(await readFile(path.join(root, "current.json")), pointer);
          const terminal = JSON.parse(
            await readFile(path.join(options.transactionDirectory, "RolledBack.state.json")),
          );
          assert.equal(terminal.state, "RolledBack");
          const attempts = path.join(root, "update/recovery-attempts");
          const records = await readdir(attempts);
          const reports = await Promise.all(
            records.map(async (name) =>
              JSON.parse(await readFile(path.join(attempts, name, "result.json"))),
            ),
          );
          assert(
            reports.some(
              (report) =>
                report.passed === true &&
                report.healthChecks.length >= 2 &&
                report.healthChecks.every((health) => health.ready === true),
            ),
            "Automatic recovery Doctor evidence missing",
          );
          const repeated = await promisify(execFile)(
            path.join(root, "bin/honeybee.exe"),
            ["--version"],
            { cwd: root, windowsHide: true, timeout: 30000 },
          );
          assert.equal(repeated.stdout.trim(), pin.version);
          assert.deepEqual(
            await readdir(attempts),
            records,
            "Repeat launch unexpectedly reran recovery",
          );
          result = {
            state: "RolledBack",
            desktop,
            automatic: true,
            refusals,
            repeatedLaunch: true,
          };
        } else
          for (let attempt = 0; attempt < 40; attempt++)
            try {
              result = await withApplicationActivity(
                { installationRoot: root, mode: "exclusive", timeoutMs: 10000 },
                async () => recoverPublishedUpdateWithDoctor(options, await hooksFor(config)),
              );
              break;
            } catch (e) {
              if (!/lock unavailable/u.test(e.message) || attempt === 39) throw e;
              await setTimeout(50);
            }
        if (pin.desktopLifecycle && !pin.startupRecovery)
          result.desktop = await runDesktopUpdateScenario(
            { ...config, mode: "recovery-only" },
            await hooksFor(config),
            pin,
          );
      } else result = await activatePublishedUpdateWithDoctor(options, await hooksFor(config));
      assert.equal(
        result.state,
        mode === "cancel"
          ? "Cancelled"
          : ["commit", "restart-failure"].includes(mode)
            ? "Committed"
            : "RolledBack",
      );
      if (["commit", "restart-failure"].includes(mode))
        assert.equal(
          JSON.parse(await readFile(path.join(root, "current.json"))).activeVersion,
          pin.targetVersion,
        );
      else assert.deepEqual(await readFile(path.join(root, "current.json")), pointer);
      await verifySource(root);
      await verifyPublishedVersion(options);
      await checkGuest(baseline);
      const evidence = { mode, passed: true, result, preserved: true };
      await writeFile(path.join(root, "result.json"), JSON.stringify(evidence, null, 2));
      results.push(evidence);
      process.stdout.write(mode + " PASSED\n");
    } catch (error) {
      await writeFile(
        path.join(root, "failure.json"),
        JSON.stringify(
          { message: error.message, stack: error.stack, healthChecks: error.healthChecks },
          null,
          2,
        ),
      );
      throw error;
    }
  }
  await writeFile(
    path.join(bundle, "two-version-result.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        passed: true,
        baseline,
        results,
        ...(pin.setupSource ? { setupSource: true, setupSha256: pin.setupSha256 } : {}),
      },
      null,
      2,
    ),
  );
  if (pin.setupSource)
    process.stdout.write(
      "Setup-installed automatic recovery PASSED; retain Cases and two-version-result.json\n",
    );
  process.stdout.write(
    "Two-version qualification PASSED; retain Cases and two-version-result.json\n",
  );
}
