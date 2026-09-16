import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { publishAssembly } from "./publish-assembly.mjs";
import { inventoryTree } from "./fresh-install.mjs";

async function fixture() {
  const parent = path.resolve("output/assembly-publication-tests/output/installations");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "0.1.0-beta.12-"));
  const staging = path.join(root, "staging"),
    destination = path.join(root, "HoneyBee");
  for (const name of [
    "versions/0.1.0-beta.12/launch.json",
    "bin/honeybee.exe",
    "HoneyBeeLauncher.exe",
    "current.json",
  ]) {
    const file = path.join(staging, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name);
  }
  return { staging, destination };
}
const locked = () => {
  throw Object.assign(new Error("sharing lock"), { code: "EPERM" });
};
test("assembly retries only the final rename after a transient sharing failure", async () => {
  const f = await fixture();
  let calls = 0;
  await publishAssembly(f.staging, f.destination, {
    wait: async () => {},
    move: async (...args) => {
      if (calls++ === 0) locked();
      await rename(...args);
    },
  });
  assert.equal(calls, 2);
  await assert.rejects(lstat(f.staging), { code: "ENOENT" });
});
test("a destination appearing during retry is never adopted or overwritten", async () => {
  const f = await fixture();
  let calls = 0;
  await assert.rejects(
    publishAssembly(f.staging, f.destination, {
      wait: async () => mkdir(f.destination),
      move: async () => {
        calls++;
        locked();
      },
    }),
    /already exists/,
  );
  assert.equal(calls, 1);
  await lstat(f.staging);
});
test("a sustained build lock preserves staging and verifies a new copied artifact", async () => {
  const f = await fixture(),
    before = await inventoryTree(f.staging);
  await publishAssembly(f.staging, f.destination, {
    allowCopy: true,
    wait: async () => {},
    move: locked,
  });
  assert.deepEqual(await inventoryTree(f.staging), before);
  assert.deepEqual(await inventoryTree(f.destination), before);
  await assert.rejects(
    publishAssembly(f.staging, f.destination, { allowCopy: true }),
    /already exists/,
  );
});
