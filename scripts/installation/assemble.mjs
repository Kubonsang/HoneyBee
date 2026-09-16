import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import runtimePin from "./runtime-pin.json" with { type: "json" };
import { publishAssembly } from "./publish-assembly.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (target) => JSON.parse(await readFile(target, "utf8"));
const version = (await json(path.join(repository, "package.json"))).version;
assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version), "Unsafe version directory");
const packageDirectory = (name) => {
  const value = process.env[name] ?? "release";
  assert(
    value !== "." && value !== ".." && path.basename(value) === value,
    "Package directory must be a single name",
  );
  return value;
};
const desktop = path.join(
  repository,
  "apps/desktop",
  packageDirectory("HONEYBEE_DESKTOP_PACKAGE_DIR"),
  "HoneyBee-win32-x64",
);
const cli = path.join(
  repository,
  "apps/cli",
  packageDirectory("HONEYBEE_CLI_PACKAGE_DIR"),
  "HoneyBee-cli-win32-x64",
);
const runtime = path.join(repository, "output/node-runtime");
const launcherDirectory =
  process.env.HONEYBEE_INCLUDE_RECOVERY_RUNTIME === "1" ? "launcher-recovery" : "launcher";
const tools = path.join(desktop, "resources/win32-x64");
const activityMarker = async (directory) => {
  try {
    return await json(path.join(directory, "activity-client.json"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};
const desktopActivity = await activityMarker(desktop),
  cliActivity = await activityMarker(cli);
let activity;
if (desktopActivity !== undefined || cliActivity !== undefined) {
  for (const marker of [desktopActivity, cliActivity])
    assert.deepEqual(marker, { schemaVersion: 1, protocol: 1 }, "Mixed activity protocol packages");
  activity = {
    protocol: 1,
    helperSha256: hash(
      await readFile(path.join(repository, "output/update-tools/honeybee-update-package.exe")),
    ),
  };
}
const inventory = await json(path.join(tools, "manifest.json"));
const compatibility = await json(path.join(desktop, "resources/component-compatibility-v1.json"));
assert.equal(compatibility.honeybeeVersion, version);
assert.equal((await json(path.join(cli, "package.json"))).version, version);
const approved = compatibility.workspaceStorage.find(
  (item) => item.version === inventory.workspaceStorageVersion,
);
assert(approved, "Storage payload is not approved for this Desktop");
for (const payload of approved.payloads) {
  assert.equal(hash(await readFile(path.join(tools, payload.fileName))), payload.sha256);
  assert.equal(hash(await readFile(path.join(cli, "dist", payload.fileName))), payload.sha256);
}
const provenance = await json(path.join(runtime, "runtime-source.json"));
assert.deepEqual(provenance, runtimePin, "Node runtime provenance differs from the approved pin");
assert.equal(hash(await readFile(path.join(runtime, "node.exe"))), provenance.nodeSha256);
assert.equal(hash(await readFile(path.join(runtime, "LICENSE"))), provenance.licenseSha256);

// Generated output only. Never overwrite an existing installation or user state.
const output = path.join(repository, "output/installations");
await mkdir(output, { recursive: true });
assert.equal(
  (await realpath(output)).toLowerCase(),
  output.toLowerCase(),
  "Redirected output directory",
);
const build = await mkdtemp(path.join(output, `${version}-`));
const staging = path.join(build, "staging");
const release = path.join(staging, "versions", version);
await mkdir(path.join(staging, "bin"), { recursive: true });
await mkdir(release, { recursive: true });
const copyTree = async (source, destination) => {
  const info = await lstat(source);
  assert(!info.isSymbolicLink(), `Package contains a redirected entry: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source))
      await copyTree(path.join(source, entry), path.join(destination, entry));
  } else {
    assert(info.isFile(), "Package entry must be a regular file");
    await cp(source, destination, { errorOnExist: true, force: false });
  }
};
await copyTree(desktop, path.join(release, "desktop"));
await copyTree(cli, path.join(release, "cli"));
await copyTree(tools, path.join(release, "tools"));
await mkdir(path.join(release, "runtime"));
for (const name of ["node.exe", "LICENSE", "runtime-source.json"])
  await copyTree(path.join(runtime, name), path.join(release, "runtime", name));
if (activity)
  await copyTree(
    path.join(repository, "output/update-tools/honeybee-update-package.exe"),
    path.join(release, "runtime/honeybee-lifecycle.exe"),
  );
for (const name of ["HoneyBeeLauncher.exe", "bin/honeybee.exe"])
  await copyTree(
    path.join(repository, "output", launcherDirectory, name),
    path.join(staging, name),
  );
const installation =
  JSON.stringify(
    {
      schemaVersion: 1,
      version,
      componentVersion: approved.version,
      ...(activity ? { activity } : {}),
      clientSha256: approved.payloads.find((item) => item.role === "client").sha256,
      controlSha256: approved.payloads.find((item) => item.role === "host").sha256,
    },
    null,
    2,
  ) + "\n";
await writeFile(path.join(release, "installation.json"), installation);
const manifest =
  JSON.stringify(
    {
      schemaVersion: 1,
      version,
      desktopSha256: hash(await readFile(path.join(release, "desktop/HoneyBee.exe"))),
      nodeSha256: provenance.nodeSha256,
      cliSha256: hash(await readFile(path.join(release, "cli/dist/cli.js"))),
      installationSha256: hash(installation),
    },
    null,
    2,
  ) + "\n";
await writeFile(path.join(release, "launch.json"), manifest);
await writeFile(
  path.join(staging, "current.json"),
  JSON.stringify(
    { schemaVersion: 1, generation: 1, activeVersion: version, manifestSha256: hash(manifest) },
    null,
    2,
  ) + "\n",
);
const published = path.join(build, "HoneyBee");
let launcherBuild;
try {
  launcherBuild = await json(
    path.join(repository, "output", launcherDirectory, "launcher-build.json"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (launcherDirectory === "launcher-recovery")
  assert(
    launcherBuild?.schemaVersion === 1 &&
      /^[a-f0-9]{64}$/u.test(launcherBuild.recoveryManifestSha256),
    "Recovery-enabled launcher build metadata required",
  );
if (launcherBuild?.recoveryManifestSha256) {
  const recovery = path.join(repository, "output", launcherDirectory, "recovery/v1");
  assert.equal(
    hash(await readFile(path.join(recovery, "manifest.json"))),
    launcherBuild.recoveryManifestSha256,
  );
  const approvedSource = await json(path.join(recovery, "approved-source.json"));
  assert.equal(
    approvedSource.version,
    version,
    "Recovery runtime approves a different source release",
  );
  assert.equal(approvedSource.launchSha256, hash(manifest), "Recovery source launch pin mismatch");
  for (const [name, digest] of Object.entries(approvedSource.files)) {
    assert(
      !name.includes("\\") &&
        !name.includes(":") &&
        name.split("/").every((part) => part && part !== "." && part !== ".."),
    );
    assert.equal(
      hash(await readFile(path.join(release, name))),
      digest,
      `Recovery source mismatch: ${name}`,
    );
  }
  await copyTree(recovery, path.join(staging, "recovery/v1"));
}
await copyTree(
  path.join(repository, "docs/operations/windows-installation-preview.md"),
  path.join(staging, "README.md"),
);
await publishAssembly(staging, published, { allowCopy: true });
process.stdout.write(`${published}\n`);
