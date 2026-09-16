import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";

/** Materializes existing signed QA inputs. Never installs, transfers, publishes,
 * alters acceptance, or deletes previous bundles. */
export async function buildIntegratedBundle({
  repositoryRoot,
  inputs,
  baselineInstallation,
  guest,
  outputRoot,
}) {
  assert.equal(inputs.qualificationOnly, true);
  assert.equal(inputs.publicationAllowed, false);
  assert.equal(inputs.executed, false);
  assert.equal(inputs.servicePair.historicalMigrationQualified, false);
  assert.equal(inputs.servicePair.sourceKind, "instrumented-qa-baseline");
  const capabilities = JSON.parse(
    (
      await promisify(execFile)(
        path.join(
          baselineInstallation,
          "versions",
          inputs.servicePair.source.version,
          "tools/honeybee-workspace-storage-host.exe",
        ),
        ["qualification-capabilities"],
        { windowsHide: true, timeout: 15000 },
      )
    ).stdout,
  );
  assert.equal(capabilities.qualificationOnly, true);
  assert.equal(
    capabilities.protectedCheckpoints,
    1,
    "Rebuild the QA baseline with protected checkpoints",
  );
  assert(/^[A-Za-z0-9-]{1,63}$/u.test(guest.computerName));
  assert(/^S-1-5-21-\d+-\d+-\d+-\d+$/u.test(guest.userSid));
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(path.join(outputRoot, "integrated-"));
  const files = [];
  const copy = async (source, relative, expected) => {
    assert(
      /^[A-Za-z0-9._/-]+$/u.test(relative) &&
        relative.split("/").every((p) => p && p !== "." && p !== ".."),
      "Unsafe destination",
    );
    const digest = await digestDistributionFile(source);
    if (expected) assert.deepEqual(digest, expected);
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    assert.deepEqual(await digestDistributionFile(target), digest);
    files.push({ path: relative, ...digest });
  };
  for (const artifact of inputs.artifacts)
    await copy(artifact.source, artifact.destination, {
      sha256: artifact.sha256,
      size: artifact.size,
    });
  const artifactCount = files.length;
  for (const folder of ["scripts/update", "scripts/installation"])
    for (const file of await readdir(path.join(repositoryRoot, folder)))
      if (file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
        await copy(path.join(repositoryRoot, folder, file), `${folder}/${file}`);
  for (const file of [
    "guest-integrated.mjs",
    "reviewed-baseline.mjs",
    "retired-payloads.mjs",
    "integrated-dataset.mjs",
    "prepared-reuse.mjs",
    "integrated-flow.mjs",
    "focused-interruption.mjs",
    "preservation.mjs",
    "final-acceptance.mjs",
    "inspect-integrated-guest.ps1",
    "run-integrated.ps1",
    "fault-worker.mjs",
    "interruption-matrix.mjs",
    "windows-matrix.mjs",
    "native-fault-controller.ps1",
    "launch-native-fault.ps1",
    "host-poweroff.ps1",
  ])
    await copy(
      path.join(repositoryRoot, "scripts/qualification", file),
      `scripts/qualification/${file}`,
    );
  const runtime = path.join(baselineInstallation, "recovery/v1");
  await copy(path.join(runtime, "runtime/node.exe"), "runtime/node.exe");
  await copy(path.join(runtime, "runtime/LICENSE"), "runtime/LICENSE");
  await copy(
    path.join(runtime, "output/update-tools/honeybee-update-package.exe"),
    "output/update-tools/honeybee-update-package.exe",
  );
  // Reuse the exact core shipped with the pinned QA baseline, not mutable dist.
  await copy(path.join(runtime, "packages/core/package.json"), "packages/core/package.json");
  for (const file of await readdir(path.join(runtime, "packages/core/dist")))
    if (file.endsWith(".js"))
      await copy(path.join(runtime, "packages/core/dist", file), `packages/core/dist/${file}`);
  const write = async (relative, bytes) => {
    await writeFile(path.join(directory, relative), bytes, { flag: "wx" });
    files.push({
      path: relative,
      ...(await digestDistributionFile(path.join(directory, relative))),
    });
  };
  const portableInputs = {
    ...inputs,
    artifacts: inputs.artifacts.map(({ destination, sha256, size }) => ({
      destination,
      sha256,
      size,
    })),
  };
  await write("inputs.json", JSON.stringify(portableInputs, null, 2) + "\n");
  await write("guest.json", JSON.stringify(guest, null, 2) + "\n");
  await write(
    "HoneyBee-Integrated-QA.cmd",
    '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\qualification\\run-integrated.ps1"\r\n',
  );
  await write(
    "README.txt",
    [
      "QA ONLY. Qualification completion and publication permission are separate.",
      "Run HoneyBee-Integrated-QA.cmd as the original unelevated QA user on the pinned VM.",
      inputs.reviewedBaseline
        ? "Continues the reviewed committed beta.22 installation and original populated dataset. No clean install or dataset recreation. Requires Git and 16 GiB free."
        : "Requires a clean disposable VM baseline: no HoneyBee installation or storage service/store, Git on PATH, 16 GiB free.",
      "Unrelated installation state is refused; this runner does not delete, uninstall, reset, or restore checkpoints.",
      "Flow: QA baseline Setup -> registered project + real Library VHDX Workspace -> service replacement -> matching Setup Repair -> two app updates.",
      "Approve HoneyBee's service UAC prompts and close Setup when it finishes. The driver itself stays unelevated.",
      "Source, dirty files, branches and bindings are compared after every transition. Library seed is synthetic, not a Unity import test.",
      "The baseline service is explicitly instrumented for checkpoints; production builds exclude these commands. No legacy hb12 migration support is claimed.",
      "Runs exactly 7 process interruptions, 2 guest reboots, 1 host forced power-off, and the existing app/service rollback cases. No acceptance gate is automatically promoted.",
      "For restart/poweroff: act within the five-minute checkpoint hold, then sign in and rerun the SAME command. Completed cases are retained. Poweroff requires scripts/qualification/host-poweroff.ps1 on the host using the printed case path and nonce.",
      "A reviewed failed case may be retried via run-integrated.ps1 -RetryCase <fixed-case-id>; previous evidence is retained and source health/preservation must pass first.",
      "Keep Evidence and installed update records on failure; the driver deliberately refuses automatic replay.",
    ].join("\r\n") + "\r\n",
  );
  const runnerFiles = files.slice(artifactCount);
  await writeFile(
    path.join(directory, "runner-files.json"),
    JSON.stringify({ schemaVersion: 1, files: runnerFiles }, null, 2) + "\n",
    { flag: "wx" },
  );
  return {
    schemaVersion: 1,
    directory,
    candidate: inputs.candidate,
    files: files.length + 1,
    bytes: files.reduce((n, f) => n + f.size, 0),
    integratedSequenceReady: true,
    interruptionMatrixImplemented: true,
    fullMatrixReady: false,
    executed: false,
    transferred: false,
    publicationAllowed: false,
  };
}
