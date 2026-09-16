import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { acquireInstalledActivity } from "./installed-activity.js";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const helper = path.resolve("output/update-tools/honeybee-update-package.exe");
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/update/build-package-tool.mjs"], {
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env, GOCACHE: path.resolve("output/go-cache") },
  });
}, 120000);
const fixture = async (enabled = true) => {
  const base = path.resolve("output/installed-activity-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")),
    release = path.join(root, "versions/0.1.0-beta.11");
  await mkdir(path.join(release, "tools"), { recursive: true });
  await mkdir(path.join(release, "runtime"));
  await mkdir(path.join(root, "update"));
  await writeFile(path.join(release, "tools/unity-workspace-storage.exe"), "client");
  await writeFile(path.join(release, "tools/honeybee-workspace-storage-host.exe"), "host");
  await cp(helper, path.join(release, "runtime/honeybee-lifecycle.exe"));
  const installation = JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0-beta.11",
    componentVersion: "test",
    clientSha256: hash("client"),
    controlSha256: hash("host"),
    ...(enabled ? { activity: { protocol: 1, helperSha256: hash(await readFile(helper)) } } : {}),
  });
  await writeFile(path.join(release, "installation.json"), installation);
  await writeFile(
    path.join(release, "launch.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0-beta.11",
      installationSha256: hash(installation),
    }),
  );
  return { root, release };
};
it("keeps portable and legacy installs explicitly unleased", async () => {
  expect(await acquireInstalledActivity(path.resolve("portable"))).toBeUndefined();
  expect(await acquireInstalledActivity((await fixture(false)).release)).toBeUndefined();
});
it("shared application leases coexist and release idempotently", async () => {
  const f = await fixture(),
    first = await acquireInstalledActivity(f.release),
    second = await acquireInstalledActivity(f.release);
  try {
    expect(first).toBeDefined();
    first?.assertHeld();
    second?.assertHeld();
  } finally {
    await first?.release();
    await first?.release();
    await second?.release();
  }
  expect(() => first?.assertHeld()).toThrow();
});
it("a modified helper is refused before execution", async () => {
  const f = await fixture();
  await writeFile(path.join(f.release, "runtime/honeybee-lifecycle.exe"), "modified");
  await expect(acquireInstalledActivity(f.release)).rejects.toMatchObject({
    code: "installation.activity-invalid",
  });
});
it("real CLI entry refuses an exclusive updater and runs after release", async () => {
  const f = await fixture(),
    cli = path.join(f.release, "cli");
  await mkdir(path.join(cli, "node_modules/@honeybee"), { recursive: true });
  await cp(path.resolve("apps/cli/dist"), path.join(cli, "dist"), { recursive: true });
  await writeFile(path.join(cli, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(
    path.resolve("packages/core"),
    path.join(cli, "node_modules/@honeybee/core"),
    "junction",
  );
  const child = spawn(helper, ["activity", path.join(f.root, "update"), "exclusive", "10000"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (bytes: Buffer) => {
        output += bytes.toString();
        if (output.includes("HELD")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("helper exited")));
    });
    await expect(
      promisify(execFile)(process.execPath, [path.join(cli, "dist/cli.js"), "--version"], {
        windowsHide: true,
        timeout: 10000,
      }),
    ).rejects.toMatchObject({ code: 1 });
  } finally {
    child.stdin.end();
    await exited;
  }
  const result = await promisify(execFile)(
    process.execPath,
    [path.join(cli, "dist/cli.js"), "--version"],
    { windowsHide: true, timeout: 10000 },
  );
  expect(result.stdout.trim()).toBe("0.1.0-beta.11");
}, 20000);
