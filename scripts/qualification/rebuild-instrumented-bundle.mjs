import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { buildServicePair } from "./build-service-pair.mjs";
import { createFinalInputs } from "./final-inputs.mjs";
import { buildIntegratedBundle } from "./build-integrated-bundle.mjs";

// Build-only entry point: no installer execution, SCM/VM changes, GitHub publish
// or replacement of the production distribution. Each attempt keeps its logs.
assert.equal(process.argv.length, 2, "This pinned QA build takes no overrides");
const repository = path.resolve(import.meta.dirname, "../..");
const json = async (file) => JSON.parse(await readFile(path.join(repository, file), "utf8"));
const base = path.join(repository, "output/instrumented-qa-builds");
await mkdir(base, { recursive: true });
const attempt = await mkdtemp(path.join(base, "build-"));
const env = {
  ...process.env,
  HONEYBEE_WORKSPACE_STORAGE_SOURCE: path.join(repository, "output/storage-source-cfa606fd4143"),
  HONEYBEE_MAKENSIS: path.join(repository, "output/nsis-toolchain/makensis.exe"),
};
const run = async (name, args, cwd = repository, extra = {}) => {
  process.stdout.write(name + "\n");
  try {
    const result = await promisify(execFile)(process.execPath, args, {
      cwd,
      env: { ...env, ...extra },
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(path.join(attempt, name + ".log"), result.stdout + result.stderr, {
      flag: "wx",
    });
    return result.stdout.trim();
  } catch (error) {
    await writeFile(
      path.join(attempt, name + ".failed.log"),
      String(error) + "\n" + (error.stdout ?? "") + "\n" + (error.stderr ?? ""),
      { flag: "wx" },
    );
    throw error;
  }
};
await run("prepare-qa-tools", [
  "apps/desktop/scripts/prepare-tools.mjs",
  "--qualification-baseline",
]);
await run("baseline", [
  "scripts/qualification/build-two-version-candidate.mjs",
  "0.1.0-beta.11",
  "--maintenance-baseline",
]);
const source = await json("output/two-version-qa/candidate.json");
await run("runtime", ["scripts/installation/build-recovery-runtime.mjs", source.installation]);
await run("launcher", ["scripts/launcher/build.mjs", "--recovery"]);
await cp(
  path.join(repository, "output/launcher-recovery"),
  path.join(source.buildRoot, "output/launcher-recovery"),
  { recursive: true, force: false, errorOnExist: true },
);
source.installation = await run(
  "assembly",
  ["scripts/installation/assemble.mjs"],
  source.buildRoot,
  { HONEYBEE_INCLUDE_RECOVERY_RUNTIME: "1" },
);
await writeFile(path.join(attempt, "source.json"), JSON.stringify(source, null, 2) + "\n", {
  flag: "wx",
});
const setup = await run("setup", ["scripts/installation/build-setup.mjs", source.installation]);
const production = await json("output/current-distribution.json"),
  target = await json("output/current-integrated-candidate.json");
const publicKey = await readFile(
  path.join(repository, "output/release-inputs/release-v1-public.pem"),
  "utf8",
);
const pair = await buildServicePair({
  sourceInstallation: source.installation,
  targetInstallation: target.installation,
  targetDistribution: production.directory,
  trustedPublicKeys: [publicKey],
  outputRoot: attempt,
});
await run("sign-qa-manifest", [
  "scripts/update/sign-release.mjs",
  path.join(pair.directory, "release.json"),
  path.join(process.env.LOCALAPPDATA, "HoneyBeeRelease/release-v1.dpapi"),
  path.join(repository, "output/release-inputs/release-v1-public.pem"),
  path.join(pair.directory, "release.sig.json"),
]);
pair.signed = true;
await writeFile(path.join(attempt, "pair.json"), JSON.stringify(pair, null, 2) + "\n", {
  flag: "wx",
});
const inputs = await createFinalInputs({
  distribution: production,
  baselineSetup: setup,
  servicePair: pair,
  consecutive: await json("output/consecutive-update-candidates.json"),
  trustedPublicKeys: [publicKey],
});
await writeFile(path.join(attempt, "inputs.json"), JSON.stringify(inputs, null, 2) + "\n", {
  flag: "wx",
});
const bundle = await buildIntegratedBundle({
  repositoryRoot: repository,
  inputs,
  baselineInstallation: source.installation,
  guest: {
    computerName: "DESKTOP-9LT0JVV",
    userSid: "S-1-5-21-4199076252-3622841657-4011401391-1001",
  },
  outputRoot: path.join(repository, "output/integrated-qa"),
});
const result = { ...bundle, buildAttempt: attempt, baselineSetup: setup };
await writeFile(path.join(attempt, "bundle.json"), JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
await writeFile(
  path.join(repository, "output/current-instrumented-qa.json"),
  JSON.stringify(result, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
