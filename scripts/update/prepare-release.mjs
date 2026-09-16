import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { admitRelease, parseReleaseManifest, sha256 } from "./release-manifest.mjs";
import { plainDirectory } from "./stage-release.mjs";

const run = promisify(execFile);
export const packageTool = path.resolve(
  import.meta.dirname,
  "../../output/update-tools/honeybee-update-package.exe",
);
export const readBounded = async (target, limit = 65536) => {
  assert(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 8 * 1024 * 1024,
    "Invalid metadata limit",
  );
  const info = await lstat(target);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= limit, "Invalid metadata file");
  const file = await open(target, "r");
  try {
    const buffer = new Uint8Array(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    assert(total <= limit, "Metadata exceeds limit");
    return Buffer.from(buffer.subarray(0, total));
  } finally {
    await file.close();
  }
};
const record = async (root, name, data) => {
  const file = await open(path.join(root, name), "wx");
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
};
export const validatePreparedPayload = async (directory, inventory, manifest) => {
  const seen = [];
  const visit = async (relative = "") => {
    for (const name of await readdir(path.join(directory, relative))) {
      const entry = relative ? `${relative}/${name}` : name;
      const target = path.join(directory, entry);
      const info = await lstat(target);
      assert(!info.isSymbolicLink(), "Redirected prepared entry");
      if (info.isDirectory()) {
        await plainDirectory(target);
        await visit(entry);
      } else {
        assert(
          info.isFile() && inventory[entry] && info.size === inventory[entry].size,
          "Unexpected prepared file",
        );
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(target)) hash.update(bytes);
        assert.equal(hash.digest("hex"), inventory[entry].sha256, "Prepared file changed");
        seen.push(entry);
      }
    }
  };
  await plainDirectory(directory);
  await visit();
  assert.deepEqual(seen.sort(), Object.keys(inventory).sort(), "Prepared inventory incomplete");
  const json = async (name) => {
    assert(inventory[name], `Missing payload: ${name}`);
    const bytes = await readBounded(path.join(directory, name));
    assert.equal(sha256(bytes), inventory[name].sha256, "Metadata changed after extraction");
    return JSON.parse(bytes);
  };
  assert(inventory["desktop/resources/app.asar"]?.size > 0, "Missing Desktop application archive");
  const launch = await json("launch.json");
  const installation = await json("installation.json");
  for (const metadata of [launch, installation]) {
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.version, manifest.version, "Wrong payload version");
  }
  const match = (name, expected) => {
    assert(
      typeof expected === "string" && /^[a-f0-9]{64}$/u.test(expected),
      "Invalid payload digest",
    );
    assert.equal(inventory[name]?.sha256, expected, `Payload mismatch: ${name}`);
  };
  match("installation.json", launch.installationSha256);
  if (installation.activity !== undefined) {
    assert.equal(installation.activity.protocol, 1, "Unsupported activity protocol");
    match("runtime/honeybee-lifecycle.exe", installation.activity.helperSha256);
    for (const name of ["desktop/activity-client.json", "cli/activity-client.json"])
      assert.deepEqual(
        await json(name),
        { schemaVersion: 1, protocol: 1 },
        "Activity client marker mismatch",
      );
  }
  match("desktop/HoneyBee.exe", launch.desktopSha256);
  match("runtime/node.exe", launch.nodeSha256);
  match("cli/dist/cli.js", launch.cliSha256);
  assert.equal(
    installation.componentVersion,
    manifest.components.storage.componentVersion,
    "Wrong storage compatibility",
  );
  for (const [name, digest] of [
    ["unity-workspace-storage.exe", installation.clientSha256],
    ["honeybee-workspace-storage-host.exe", installation.controlSha256],
  ]) {
    for (const prefix of ["tools", "cli/dist", "desktop/resources/win32-x64"])
      match(`${prefix}/${name}`, digest);
  }
  assert.equal((await json("cli/package.json")).version, manifest.version);
  const compatibility = await json("desktop/resources/component-compatibility-v1.json");
  assert.equal(compatibility.honeybeeVersion, manifest.version);
  const approved = compatibility.workspaceStorage.find(
    (item) => item.version === installation.componentVersion,
  );
  assert(approved, "Storage compatibility entry missing");
  for (const [role, expected] of [
    ["client", installation.clientSha256],
    ["host", installation.controlSha256],
  ]) {
    assert.equal(approved.payloads.find((item) => item.role === role)?.sha256, expected);
  }
  for (const prefix of ["tools", "cli/dist", "desktop/resources/win32-x64"]) {
    const tools = await json(`${prefix}/manifest.json`);
    assert.equal(tools.schemaVersion, 1);
    assert.equal(tools.workspaceStorageVersion, installation.componentVersion);
    for (const [name, details] of Object.entries(tools.files)) {
      assert(
        name === path.basename(name) && !name.includes("\\") && !name.includes("/"),
        "Invalid tool manifest path",
      );
      match(`${prefix}/${name}`, details.sha256);
      assert.equal(inventory[`${prefix}/${name}`].size, details.byteLength);
    }
  }
  const runtime = await json("runtime/runtime-source.json");
  match("runtime/node.exe", runtime.nodeSha256);
  match("runtime/LICENSE", runtime.licenseSha256);
  return {
    launchManifestSha256: inventory["launch.json"].sha256,
    componentVersion: installation.componentVersion,
  };
};

/** Developer-only preparation; verified metadata is pinned again, no activation or service calls. */
export const prepareRelease = async ({
  installationRoot,
  stageAttempt,
  manifestSha256,
  source: suppliedSource,
  checkpoint = async () => {},
}) => {
  const source = { ...suppliedSource };
  const root = path.resolve(installationRoot),
    staging = path.resolve(stageAttempt);
  assert.equal(
    path.dirname(staging),
    path.join(root, "update"),
    "Stage outside installation update root",
  );
  assert(/^stage-[A-Za-z0-9]+$/u.test(path.basename(staging)), "Invalid stage attempt");
  await plainDirectory(staging);
  const manifest = parseReleaseManifest(
    await readBounded(path.join(staging, "release.json")),
    manifestSha256,
  );
  admitRelease(manifest, source);
  const pointer = await readBounded(path.join(root, "current.json"));
  const current = JSON.parse(pointer);
  assert.equal(current.schemaVersion, 1, "Unknown current pointer schema");
  assert.equal(current.activeVersion, source.currentVersion, "Source pointer changed");
  const archive = path.join(staging, "application.zip");
  assert.equal(
    (await lstat(archive)).size,
    manifest.packages.application.size,
    "Archive size changed",
  );
  const attempt = await mkdtemp(path.join(root, "update/prepare-"));
  const directory = path.join(attempt, "versions", manifest.version);
  try {
    await record(attempt, "001-Preparing.json", {
      schemaVersion: 1,
      state: "Preparing",
      manifestSha256,
      version: manifest.version,
      source,
    });
    await mkdir(path.dirname(directory));
    await checkpoint("before-extract");
    const { stdout } = await run(
      packageTool,
      ["extract", archive, directory, manifest.packages.application.sha256],
      { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
    );
    const inventory = JSON.parse(stdout);
    await record(attempt, "inventory.json", { schemaVersion: 1, files: inventory });
    await checkpoint("after-extract");
    const metadata = await validatePreparedPayload(directory, inventory, manifest);
    assert.deepEqual(
      await readBounded(path.join(root, "current.json")),
      pointer,
      "Source pointer changed during preparation",
    );
    await checkpoint("before-prepared");
    const result = {
      schemaVersion: 1,
      state: "Prepared",
      version: manifest.version,
      directory,
      manifestSha256,
      ...metadata,
      activationAllowed: false,
    };
    await record(attempt, "002-Prepared.json", result);
    return result;
  } catch (error) {
    try {
      await record(attempt, "002-Failed.json", {
        schemaVersion: 1,
        state: "Failed",
        reason: "preparation-failed",
      });
    } catch {
      /* Preserve partial evidence. */
    }
    throw new Error(`Update preparation failed; evidence retained at ${attempt}`, { cause: error });
  }
};
