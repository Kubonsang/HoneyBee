import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, open, mkdir, mkdtemp, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installFresh,
  verifyPublishedSetup,
  verifyRepairApplication,
  verifyRepairInfrastructure,
  inventoryTree,
} from "./fresh-install.mjs";
import assert from "node:assert/strict";
import { ensureSetupService } from "./service-setup.mjs";
import { repairInstalledComponents } from "./component-repair.mjs";
import { adoptInstalledProjects } from "./adopt-projects.mjs";

const bundle = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
const runSetup = async () => {
  let repairActivity;
  try {
    const source = path.join(bundle, "payload");
    const inventory = JSON.parse(await readFile(path.join(bundle, "inventory.json"), "utf8"));
    const sourceActivation = JSON.parse(await readFile(path.join(source, "current.json"), "utf8"));
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(sourceActivation.activeVersion))
      throw new Error("Invalid setup version");
    const sourceCore = await import(
      pathToFileURL(
        path.join(
          source,
          "versions",
          sourceActivation.activeVersion,
          "cli/node_modules/@honeybee/core/dist/index.js",
        ),
      ).href
    );
    const git = await sourceCore.checkGitExecutable();
    if (git.status !== "pass") {
      process.stdout.write(
        JSON.stringify({ installed: false, ready: false, prerequisite: git }) + "\n",
      );
      process.exitCode = 3;
      return;
    }
    const allowInstall = process.argv.slice(3).includes("--install-service");
    const repair = process.argv.slice(3).includes("--repair");
    const adoptProjects = process.argv.slice(3).includes("--adopt-projects");
    let installedPointer;
    try {
      installedPointer = JSON.parse(await readFile(path.join(target, "current.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      !repair &&
      installedPointer &&
      installedPointer.activeVersion !== sourceActivation.activeVersion
    ) {
      const { upgradeFromSetup } = await import(
        pathToFileURL(path.join(bundle, "scripts/update/setup-upgrade.mjs")).href
      );
      const result = await upgradeFromSetup({
        installationRoot: target,
        mediaDirectory: path.join(bundle, "update-media"),
        expectedVersion: sourceActivation.activeVersion,
        allowServiceUpdate: allowInstall,
      });
      process.stdout.write(JSON.stringify(result) + "\n");
      // The update lifecycle already restarted the selected version.
      process.exitCode = result.ready ? 4 : 2;
      return;
    }
    const attempt = randomUUID();
    const verifySetupApplication = async () => {
      try {
        await verifyRepairApplication({ target, inventory });
      } catch {
        const { authorizeMatchingSetup } = await import(
          pathToFileURL(path.join(bundle, "scripts/update/setup-upgrade.mjs")).href
        );
        await authorizeMatchingSetup({ installationRoot: target, sourceInstallation: source });
      }
    };
    const prepareRepair = async () => {
      try {
        await verifySetupApplication();
        await sourceCore.assertApplicationRepairAdmission?.(target);
      } catch {
        // Only verified Setup code runs until the active app has been restored.
        assert.deepEqual(await inventoryTree(source), inventory, "Repair Setup payload changed");
        let runtime = path.join(source, "recovery/v1");
        try {
          await verifyRepairInfrastructure({ target, inventory });
        } catch {
          const { authorizeMatchingSetup } = await import(
            pathToFileURL(path.join(bundle, "scripts/update/setup-upgrade.mjs")).href
          );
          ({ runtime } = await authorizeMatchingSetup({
            installationRoot: target,
            sourceInstallation: source,
            verifyActive: false,
          }));
        }
        const capabilities = JSON.parse(
          (
            await promisify(execFile)(
              path.join(target, "HoneyBeeLauncher.exe"),
              ["--installation-capabilities"],
              { windowsHide: true },
            )
          ).stdout,
        );
        assert.equal(
          capabilities.applicationRepairGate,
          1,
          "Application Repair requires a recovery-capable Setup",
        );
        const { prepareApplicationRepair, recoverApplicationRepair } = await import(
          pathToFileURL(path.join(bundle, "scripts/update/repair-active.mjs")).href
        );
        const prepared = await prepareApplicationRepair({
          installationRoot: target,
          sourceInstallation: source,
          runtime,
        });
        await recoverApplicationRepair({ installationRoot: target, runtime, name: prepared.name });
        await verifySetupApplication();
      }
      const root = path.join(target, "update", "repairs");
      await mkdir(root, { recursive: true });
      if ((await realpath(root)).toLowerCase() !== path.resolve(root).toLowerCase())
        throw new Error("Redirected Repair evidence directory");
      return { pending: await mkdtemp(path.join(root, "repair-")) };
    };
    const { pending } = await (repair
      ? prepareRepair()
      : installFresh({ source, target, inventory }).catch(async (error) => {
          if (!allowInstall) throw error;
          try {
            return await verifyPublishedSetup({ target, inventory });
          } catch {
            await verifySetupApplication();
            await sourceCore.assertApplicationRepairAdmission?.(target);
            const directory = path.join(target, "update/setup-retries");
            await mkdir(directory, { recursive: true });
            assert.equal(
              (await realpath(directory)).toLowerCase(),
              path.resolve(directory).toLowerCase(),
            );
            return { pending: await mkdtemp(path.join(directory, "setup-")) };
          }
        }));
    const activation = JSON.parse(await readFile(path.join(target, "current.json"), "utf8"));
    const release = path.join(target, "versions", activation.activeVersion);
    const core = await import(
      pathToFileURL(path.join(release, "cli/node_modules/@honeybee/core/dist/index.js")).href
    );
    if (repair) {
      if (typeof core.acquireInstalledActivity !== "function")
        throw new Error("Repair requires a Setup with managed activity support");
      repairActivity = await core.acquireInstalledActivity(release);
      if (!repairActivity) throw new Error("Repair requires managed installation activity");
      repairActivity.assertHeld();
      await verifySetupApplication();
    }
    const options = await core.readInstalledStorage(release);
    const tools = new core.WorkspaceToolResolver(options).resolve();
    const storage = new core.WindowsWorkspaceStorage();
    const serviceHooks = {
      allowInstall,
      diagnose: () => storage.diagnose(tools),
      validate: () => core.requireCompatibleStorage(storage, tools),
      install: async () => {
        repairActivity?.assertHeld();
        await core.validateStorageTools(tools);
        await promisify(execFile)(
          tools.controlCommand,
          [
            "install-elevated",
            "--workspace-root",
            path.join(target, "Workspaces"),
            "--component-version",
            tools.expectedComponentVersion,
          ],
          { windowsHide: true },
        );
      },
      repairExisting: async () => {
        repairActivity?.assertHeld();
        await core.validateStorageTools(tools);
        const { createServiceUpdateSession } = await import(
          pathToFileURL(path.join(bundle, "scripts/update/service-update-session.mjs")).href
        );
        const session = createServiceUpdateSession({ executable: tools.controlCommand });
        try {
          const result = await session.request({
            schemaVersion: 1,
            operation: "repair-start",
            repair: {
              applicationRoot: target,
              componentVersion: tools.expectedComponentVersion,
              executableSha256: tools.expectedControlSha256,
            },
          });
          assert.equal(result.state, "Running");
        } finally {
          await session.close();
        }
      },
      record: async (stage, details) => {
        const file = await open(path.join(pending, `service-${attempt}-${stage}.json`), "wx");
        try {
          await file.writeFile(JSON.stringify({ schemaVersion: 1, stage, ...details }));
          await file.sync();
        } finally {
          await file.close();
        }
      },
    };
    const health = repair
      ? await repairInstalledComponents(
          { allowServiceInstall: allowInstall },
          {
            ...serviceHooks,
            verifyApplication: verifySetupApplication,
            doctor: () => new core.HoneyBeeWorkspaceCore({ storageTools: options }).doctor(),
          },
        )
      : await ensureSetupService(serviceHooks);
    const finalGit = await core.checkGitExecutable();
    const adoption =
      health.ready && adoptProjects
        ? await adoptInstalledProjects(
            new core.HoneyBeeWorkspaceCore({ storageTools: options }),
            serviceHooks.record,
          )
        : undefined;
    const ready = health.ready && finalGit.status === "pass" && adoption?.ready !== false;
    const reason =
      finalGit.status !== "pass"
        ? finalGit.message
        : adoption?.ready === false
          ? "Project tool adoption requires attention; existing registrations were preserved."
          : health.reason;
    await writeFile(
      path.join(pending, "health.json"),
      JSON.stringify(
        { schemaVersion: 1, ...health, ready, reason, adoption, prerequisites: [finalGit] },
        null,
        2,
      ),
    );
    process.stdout.write(
      JSON.stringify({ installed: true, ready, reason, evidence: pending }) + "\n",
    );
    process.exitCode = finalGit.status !== "pass" ? 3 : ready ? 0 : 2;
  } catch (error) {
    process.stderr.write(`HoneyBee setup stopped: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await repairActivity?.release();
  }
};
await runSetup();
