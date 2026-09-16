import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { bindCandidateTools } from "./candidate-tools.mjs";
const repo = path.resolve(import.meta.dirname, "../..");
const version = process.argv[2] ?? "0.1.0-beta.12";
const maintenanceBaseline = process.argv[3] === "--maintenance-baseline";
assert(
  (process.argv.length <= 3 &&
    [12, 13, 14, 16, 17, 18, 23, 24, 25, 26, 27, 28, 30, 32, 33, 34]
      .map((n) => "0.1.0-beta." + n)
      .includes(version)) ||
    (process.argv.length === 4 &&
      maintenanceBaseline &&
      [
        "0.1.0-beta.11",
        "0.1.0-beta.15",
        "0.1.0-beta.19",
        "0.1.0-beta.20",
        "0.1.0-beta.21",
        "0.1.0-beta.22",
        "0.1.0-beta.29",
        "0.1.0-beta.31",
      ].includes(version)),
  "Unsupported QA version",
);
const base = path.join(repo, "output/two-version-qa");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "build-"));
const copy = async (name) => {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await cp(path.join(repo, name), path.join(root, name), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
};
for (const name of [
  "package.json",
  "tsconfig.base.json",
  "LICENSE",
  "docs/operations",
  "scripts/installation",
  "scripts/update",
  "scripts/recovery",
  "output/node-runtime",
  "output/launcher",
  "output/update-tools",
])
  await copy(name);
for (const app of ["apps/desktop", "apps/cli", "packages/core"]) {
  for (const name of ["src", "package.json"]) await copy(`${app}/${name}`);
  if (app !== "apps/desktop") await copy(`${app}/tsconfig.json`);
  if (app !== "packages/core")
    await symlink(
      path.join(repo, app, "node_modules"),
      path.join(root, app, "node_modules"),
      "junction",
    );
}
await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
for (const name of [
  "apps/desktop/scripts",
  "apps/desktop/resources",
  "apps/desktop/vite.config.ts",
  "apps/desktop/vite.main.config.ts",
  "apps/desktop/vite.preload.config.ts",
  "apps/cli/scripts",
  "apps/cli/tsconfig.build.json",
  "packages/core/tsconfig.build.json",
])
  await copy(name);
await cp(
  process.env.HONEYBEE_QA_TOOLS_ROOT ??
    path.join(
      repo,
      "apps/desktop/.tools",
      ...(maintenanceBaseline ? ["qa-baseline"] : []),
      "win32-x64",
    ),
  path.join(root, "apps/desktop/.tools/win32-x64"),
  { recursive: true, errorOnExist: true, force: false },
);
for (const name of [
  "package.json",
  "apps/desktop/package.json",
  "apps/cli/package.json",
  "packages/core/package.json",
]) {
  const file = path.join(root, name),
    value = JSON.parse(await readFile(file));
  value.version = version;
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
const cliSource = path.join(root, "apps/cli/src/workspace-command.ts");
const code = await readFile(cliSource, "utf8");
assert(code.includes('WORKSPACE_CLI_VERSION = "0.1.0-beta.11"'));
await writeFile(
  cliSource,
  code.replace(
    'WORKSPACE_CLI_VERSION = "0.1.0-beta.11"',
    'WORKSPACE_CLI_VERSION = "' + version + '"',
  ),
);
const compatibilityFile = path.join(root, "apps/desktop/resources/component-compatibility-v1.json");
let compatibility = JSON.parse(await readFile(compatibilityFile));
compatibility.honeybeeVersion = version;
for (const item of compatibility.workspaceStorage) item.honeybeeVersion = version;
compatibility = await bindCandidateTools(
  path.join(root, "apps/desktop/.tools/win32-x64"),
  compatibility,
  maintenanceBaseline,
);
await writeFile(compatibilityFile, JSON.stringify(compatibility, null, 2) + "\n");
const run = async (label, args, cwd = root) => {
  process.stdout.write(label + "\n");
  try {
    const r = await promisify(execFile)(process.execPath, args, {
      cwd,
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GOCACHE: path.join(repo, "output/go-cache") },
    });
    await writeFile(path.join(root, label + ".log"), r.stdout + "\n" + r.stderr);
    return r.stdout.trim();
  } catch (e) {
    await writeFile(path.join(root, label + ".log"), String(e.stdout) + "\n" + String(e.stderr));
    throw e;
  }
};
await writeFile(path.join(base, "latest-build.txt"), root);
await run("build-core", [
  path.join(repo, "node_modules/typescript/bin/tsc"),
  "-p",
  "packages/core/tsconfig.build.json",
]);
await run("build-cli", [
  path.join(repo, "node_modules/typescript/bin/tsc"),
  "-p",
  "apps/cli/tsconfig.build.json",
]);
const vite = path.join(repo, "apps/desktop/node_modules/vite/bin/vite.js");
for (const config of ["vite.config.ts", "vite.preload.config.ts", "vite.main.config.ts"])
  await run(
    "build-" + config,
    [vite, "build", "--config", config],
    path.join(root, "apps/desktop"),
  );
await run("package-cli", ["apps/cli/scripts/package.mjs"]);
await run("package-desktop", ["apps/desktop/scripts/package.mjs"]);
const installation = await run("assemble", ["scripts/installation/assemble.mjs"]);
await writeFile(
  path.join(base, "candidate.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      qualificationOnly: true,
      maintenanceBaseline,
      historicalRelease: false,
      version,
      buildRoot: root,
      installation,
      sourceVersion: "0.1.0-beta.11",
      serviceMigration: false,
    },
    null,
    2,
  ),
);
process.stdout.write(installation + "\n");
