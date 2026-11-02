import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("Setup supplies canonical bundle paths to external recovery", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "honeybee-setup-path-")));
  const bundle = path.join(root, "bundle");
  const target = path.join(root, "installed");
  const core = path.join(bundle, "payload/versions/0.1.0-beta.38/cli/node_modules/@honeybee/core");
  await mkdir(path.join(core, "dist"), { recursive: true });
  await mkdir(path.join(bundle, "scripts/update"), { recursive: true });
  await mkdir(target);
  for (const name of [
    "setup-entry.mjs",
    "fresh-install.mjs",
    "service-setup.mjs",
    "component-repair.mjs",
    "adopt-projects.mjs",
  ])
    await cp(path.join(import.meta.dirname, name), path.join(bundle, name));
  await writeFile(path.join(bundle, "inventory.json"), "{}");
  await writeFile(
    path.join(bundle, "payload/current.json"),
    JSON.stringify({ activeVersion: "0.1.0-beta.38" }),
  );
  await writeFile(
    path.join(target, "current.json"),
    JSON.stringify({ activeVersion: "0.1.0-beta.35" }),
  );
  await writeFile(path.join(core, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(core, "dist/index.js"),
    'export async function checkGitExecutable(){return {status:"pass"};}',
  );
  // The real entry point must normalize the arguments before handing control
  // to recovery. This adapter never installs, stages, starts a service or UAC.
  await writeFile(
    path.join(bundle, "scripts/update/setup-upgrade.mjs"),
    `import assert from "node:assert/strict";
import {realpath} from "node:fs/promises";
import path from "node:path";
export async function resumeLegacySetupUpgrade({mediaDirectory}) {
  const bundle=path.dirname(mediaDirectory);
  assert.equal(bundle,await realpath(bundle),"Setup passed a noncanonical bundle path");
  return {ready:false,canonicalBundle:true};
}`,
  );
  const check = async (directory) => {
    await assert.rejects(
      run(process.execPath, [path.join(directory, "setup-entry.mjs"), target]),
      (error) => {
        assert.equal(error.code, 2, error.stderr);
        assert.equal(JSON.parse(error.stdout).canonicalBundle, true);
        return true;
      },
    );
  };
  await check(bundle);
  if (process.platform === "win32") {
    const { stdout } = await run("cmd.exe", ["/d", "/c", `for %I in ("${bundle}") do @echo %~sI`], {
      windowsVerbatimArguments: true,
    });
    const short = stdout.trim();
    if (short.toLowerCase() !== bundle.toLowerCase()) {
      await check(short);
      t.diagnostic("Actual Windows 8.3 alias exercised");
    } else t.diagnostic("8.3 names unavailable on this volume; canonical path exercised");
  }
});
