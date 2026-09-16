import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { installSetupSource } from "./setup-source.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const base = path.resolve("output/setup-source-tests");
  await mkdir(base, { recursive: true });
  const bundle = await mkdtemp(path.join(base, "bundle-"));
  await mkdir(path.join(bundle, "Cases"));
  const target = await mkdtemp(path.join(bundle, "Cases/case-"));
  const files = [
    "versions/1.0.0/app.exe",
    "bin/honeybee.exe",
    "HoneyBeeLauncher.exe",
    "current.json",
    "recovery/v1/runtime/node.exe",
  ];
  const inventory = Object.fromEntries(files.map((name) => [name, hash(name)]));
  const bytes = JSON.stringify(inventory);
  await writeFile(path.join(bundle, "HoneyBeeSetup-preview.exe"), "setup");
  await writeFile(path.join(bundle, "setup-inventory.json"), bytes);
  const pin = { setupSha256: hash("setup"), setupInventorySha256: hash(bytes) };
  let calls = 0;
  const run = async (exe, args, options) => {
    calls++;
    assert.equal(exe, path.join(bundle, "HoneyBeeSetup-preview.exe"));
    assert.deepEqual(args, ["/S", `/D=${target}`]);
    assert.equal(options.windowsHide, true);
    for (const name of files) {
      await mkdir(path.dirname(path.join(target, name)), { recursive: true });
      await writeFile(path.join(target, name), name);
    }
    await mkdir(path.join(target, ".setup-pending"));
    await writeFile(
      path.join(target, ".setup-pending/health.json"),
      JSON.stringify({ ready: true, serviceAction: "none" }),
    );
  };
  return { bundle, target, pin, run, calls: () => calls };
}
test("pinned silent Setup supplies the actual recovery case payload", async () => {
  const options = await fixture();
  assert.equal((await installSetupSource(options)).files, 5);
  assert.equal(options.calls(), 1);
});
for (const name of ["HoneyBeeSetup-preview.exe", "setup-inventory.json"]) {
  test(`tampered ${name} cannot run Setup`, async () => {
    const options = await fixture();
    await writeFile(path.join(options.bundle, name), "tampered");
    await assert.rejects(installSetupSource(options), /mismatch/);
    assert.equal(options.calls(), 0);
  });
}
test("existing case evidence cannot be overwritten", async () => {
  const options = await fixture();
  const evidence = path.join(options.target, "evidence.json");
  await writeFile(evidence, "preserve");
  await assert.rejects(installSetupSource(options), /must be empty/);
  assert.equal(options.calls(), 0);
  assert.equal(await readFile(evidence, "utf8"), "preserve");
});
for (const failure of ["exit", "payload", "health", "service"]) {
  test(`Setup ${failure} failure blocks the update scenario`, async () => {
    const options = await fixture();
    await assert.rejects(
      installSetupSource({
        ...options,
        run: async (...args) => {
          if (failure === "exit") throw new Error("Setup exited 2");
          await options.run(...args);
          if (failure === "payload")
            await writeFile(path.join(options.target, "recovery/v1/runtime/node.exe"), "changed");
          else
            await writeFile(
              path.join(options.target, ".setup-pending/health.json"),
              JSON.stringify({
                ready: failure !== "health",
                serviceAction: failure === "service" ? "installed" : "none",
              }),
            );
        },
      }),
    );
  });
}
