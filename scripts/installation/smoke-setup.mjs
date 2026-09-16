import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { inventoryTree } from "./fresh-install.mjs";

const setup = process.argv[2];
assert(setup && path.isAbsolute(setup), "Usage: smoke-setup.mjs <absolute setup.exe>");
const expectedInventory = JSON.parse(
  await readFile(path.join(path.dirname(setup), "bundle/inventory.json"), "utf8"),
);
const output = path.resolve("output/setup-smoke");
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, "case-"));
const target = path.join(root, "HoneyBee 설치");
await mkdir(path.join(target, "workspace-core"), { recursive: true });
const registry = path.join(target, "workspace-core/workspace-registry.v2.json");
await writeFile(registry, "preserve this byte-for-byte");
const run = promisify(execFile);
const invoke = async (env = process.env) => {
  try {
    await run(setup, ["/S", `/D=${target}`], {
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 300_000,
    });
    return 0;
  } catch (error) {
    if (typeof error.code === "number") return error.code;
    throw error;
  }
};
// The private runtime must work without PATH, but missing Git must fail before publication.
assert.equal(await invoke({ ...process.env, PATH: "" }), 3, "Missing Git must block setup");
assert.equal(await readFile(registry, "utf8"), "preserve this byte-for-byte");
await assert.rejects(readFile(path.join(target, ".setup-pending/prepared.json")), {
  code: "ENOENT",
});
await assert.rejects(readFile(path.join(target, "current.json")), { code: "ENOENT" });
// Restoring the normal environment models closing Setup and rerunning after Git installation.
const code = await invoke();
assert([0, 2].includes(code), `Unexpected setup exit: ${code}`);
assert.equal(await readFile(registry, "utf8"), "preserve this byte-for-byte");
const health = JSON.parse(await readFile(path.join(target, ".setup-pending/health.json"), "utf8"));
assert.equal(health.ready, code === 0);
const before = await inventoryTree(target);
assert.deepEqual(
  before,
  expectedInventory,
  "Installed files must match the complete Setup payload",
);
const result = await run(path.join(target, "bin/honeybee.exe"), ["--version"], {
  windowsHide: true,
});
assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
assert.equal(await invoke(), 1, "Reinstall must fail instead of overwriting");
assert.deepEqual(await inventoryTree(target), before);
assert.equal(await readFile(registry, "utf8"), "preserve this byte-for-byte");
process.stdout.write(JSON.stringify({ passed: true, target, ready: health.ready }) + "\n");
