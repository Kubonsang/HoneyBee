import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "./release-manifest.mjs";
import { stageRelease } from "./stage-release.mjs";
import { packageTool } from "./prepare-release.mjs";
const run = promisify(execFile);
export const version = "0.1.0-beta.12",
  component = "0.0.0+source.hb12";
const source = {
  currentVersion: "0.1.0-beta.11",
  bootstrapperVersion: "1.0.0",
  channel: "beta",
  storageComponentVersion: component,
};
export const fixture = async (alter = () => {}) => {
  const base = path.resolve("output/update-prepare-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const payload = path.join(root, "payload");
  await mkdir(payload);
  const files = {
    "desktop/HoneyBee.exe": "desktop",
    "desktop/resources/app.asar": "application",
    "runtime/node.exe": "node",
    "runtime/LICENSE": "license",
    "cli/dist/cli.js": "cli",
    "cli/package.json": JSON.stringify({ version }),
  };
  for (const prefix of ["tools", "cli/dist", "desktop/resources/win32-x64"]) {
    files[`${prefix}/unity-workspace-storage.exe`] = "client";
    files[`${prefix}/honeybee-workspace-storage-host.exe`] = "control";
    files[`${prefix}/manifest.json`] = JSON.stringify({
      schemaVersion: 1,
      workspaceStorageVersion: component,
      files: {
        "unity-workspace-storage.exe": { sha256: sha256("client"), byteLength: 6 },
        "honeybee-workspace-storage-host.exe": { sha256: sha256("control"), byteLength: 7 },
      },
    });
  }
  files["installation.json"] = JSON.stringify({
    schemaVersion: 1,
    version,
    componentVersion: component,
    clientSha256: sha256("client"),
    controlSha256: sha256("control"),
  });
  files["launch.json"] = JSON.stringify({
    schemaVersion: 1,
    version,
    desktopSha256: sha256("desktop"),
    cliSha256: sha256("cli"),
    nodeSha256: sha256("node"),
    installationSha256: sha256(files["installation.json"]),
  });
  files["runtime/runtime-source.json"] = JSON.stringify({
    nodeSha256: sha256("node"),
    licenseSha256: sha256("license"),
  });
  files["desktop/resources/component-compatibility-v1.json"] = JSON.stringify({
    honeybeeVersion: version,
    workspaceStorage: [
      {
        version: component,
        payloads: [
          { role: "client", sha256: sha256("client") },
          { role: "host", sha256: sha256("control") },
        ],
      },
    ],
  });
  alter(files);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(payload, name)), { recursive: true });
    await writeFile(path.join(payload, name), bytes);
  }
  const archive = path.join(root, "application.zip");
  await run(packageTool, ["pack", payload, archive], { windowsHide: true });
  const bytes = await readFile(archive);
  const manifest = {
    schemaVersion: 1,
    version,
    channel: "beta",
    mandatory: false,
    minimumSourceVersion: source.currentVersion,
    minimumBootstrapperVersion: "1.0.0",
    packages: {
      application: {
        url: "https://github.com/Kubonsang/HoneyBee/releases/download/v12/application.zip",
        sha256: sha256(bytes),
        size: bytes.length,
        format: "zip",
      },
    },
    components: {
      desktop: { version, package: "application" },
      cli: { version, package: "application" },
      storage: {
        componentVersion: component,
        package: "application",
        migration: { kind: "none", supportedSourceVersions: [component] },
      },
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    manifestSha256 = sha256(manifestBytes);
  const installationRoot = path.join(root, "HoneyBee 설치");
  await mkdir(installationRoot);
  await writeFile(
    path.join(installationRoot, "current.json"),
    JSON.stringify({ schemaVersion: 1, activeVersion: source.currentVersion }),
  );
  await writeFile(path.join(installationRoot, "user-state"), "preserve");
  const staged = await stageRelease({
    installationRoot,
    manifestBytes,
    manifestSha256,
    source,
    fetchImpl: async () => new globalThis.Response(bytes),
  });
  return { installationRoot, stageAttempt: staged.attempt, manifestSha256, source };
};
export const preserved = async (options) => {
  assert.equal(
    JSON.parse(await readFile(path.join(options.installationRoot, "current.json"))).activeVersion,
    source.currentVersion,
  );
  assert.equal(
    await readFile(path.join(options.installationRoot, "user-state"), "utf8"),
    "preserve",
  );
  await assert.rejects(readdir(path.join(options.installationRoot, "versions")), {
    code: "ENOENT",
  });
};
