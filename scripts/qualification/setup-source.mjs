import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inventoryTree } from "../installation/fresh-install.mjs";

// QA only: an empty case directory, never the user's normal installation.
export async function installSetupSource({ bundle, target, pin, run = promisify(execFile) }) {
  const cases = path.join(bundle, "Cases");
  assert.equal(path.dirname(target), cases);
  assert(/^case-[A-Za-z0-9]+$/u.test(path.basename(target)));
  assert.equal((await realpath(target)).toLowerCase(), path.resolve(target).toLowerCase());
  assert.deepEqual(await readdir(target), [], "Setup case must be empty");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const setup = path.join(bundle, "HoneyBeeSetup-preview.exe");
  assert.equal(digest(await readFile(setup)), pin.setupSha256, "Setup digest mismatch");
  const bytes = await readFile(path.join(bundle, "setup-inventory.json"));
  assert.equal(digest(bytes), pin.setupInventorySha256, "Setup inventory mismatch");
  const inventory = JSON.parse(bytes);
  assert(Object.keys(inventory).some((name) => name.startsWith("recovery/v1/")));
  await run(setup, ["/S", `/D=${target}`], {
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout: 300000,
  });
  assert.deepEqual(await inventoryTree(target), inventory, "Setup installed payload mismatch");
  const health = JSON.parse(await readFile(path.join(target, ".setup-pending/health.json")));
  assert.equal(health.ready, true, "Setup health check failed");
  assert.equal(health.serviceAction, "none", "QA Setup must not install a service");
  return { setupSha256: pin.setupSha256, files: Object.keys(inventory).length, health };
}
