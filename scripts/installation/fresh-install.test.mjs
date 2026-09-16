import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, symlink, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { inventoryTree, installFresh, verifyPublishedSetup } from "./fresh-install.mjs";

const fixture = async () => {
  const output = path.resolve("output/setup-tests");
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, "case-"));
  const source = path.join(root, "source");
  const target = path.join(root, "설치 with spaces");
  for (const name of [
    "versions/1.0.0/app.exe",
    "bin/honeybee.exe",
    "HoneyBeeLauncher.exe",
    "current.json",
  ]) {
    const file = path.join(source, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name);
  }
  await mkdir(path.join(target, "workspace-core"), { recursive: true });
  await writeFile(path.join(target, "workspace-core/registry.json"), "user data");
  return { source, target, inventory: await inventoryTree(source) };
};

const recoveryFixture = async () => {
  const options = await fixture();
  for (const name of ["manifest.json", "runtime/node.exe", "scripts/recovery/startup.mjs"]) {
    const file = path.join(options.source, "recovery/v1", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `recovery payload: ${name}`);
  }
  options.inventory = await inventoryTree(options.source);
  return options;
};

test("setup publishes optional recovery bytes before activating and binds service retry to them", async () => {
  const options = await recoveryFixture();
  await installFresh({
    ...options,
    checkpoint: async (step) => {
      if (step !== "before:current.json") return;
      for (const name of Object.keys(options.inventory).filter((entry) =>
        entry.startsWith("recovery/"),
      ))
        assert.deepEqual(
          await readFile(path.join(options.target, name)),
          await readFile(path.join(options.source, name)),
        );
      await assert.rejects(readFile(path.join(options.target, "current.json")), { code: "ENOENT" });
    },
  });
  assert.deepEqual(await inventoryTree(options.target), options.inventory);
  await verifyPublishedSetup(options);
  await writeFile(path.join(options.target, "recovery/v1/runtime/node.exe"), "tampered");
  await assert.rejects(verifyPublishedSetup(options), /payload changed/);
});

for (const damage of ["interruption", "missing", "changed"]) {
  test(`recovery ${damage} during publication leaves app inactive and evidence preserved`, async () => {
    const options = await recoveryFixture();
    await assert.rejects(
      installFresh({
        ...options,
        checkpoint: async (step) => {
          if (step !== "before:recovery") return;
          if (damage === "interruption") throw new Error("injected interruption");
          const file = path.join(options.source, "recovery/v1/runtime/node.exe");
          if (damage === "missing") await rename(file, file + ".moved");
          else await writeFile(file, "changed");
        },
      }),
    );
    await assert.rejects(readFile(path.join(options.target, "current.json")), { code: "ENOENT" });
    const evidence = await readFile(path.join(options.target, ".setup-pending/prepared.json"));
    await assert.rejects(installFresh(options));
    assert.deepEqual(
      await readFile(path.join(options.target, ".setup-pending/prepared.json")),
      evidence,
    );
    assert.equal(
      await readFile(path.join(options.target, "workspace-core/registry.json"), "utf8"),
      "user data",
    );
  });
}

test("recovery corruption before admission cannot create setup state", async () => {
  const options = await recoveryFixture();
  await writeFile(path.join(options.source, "recovery/v1/runtime/node.exe"), "changed");
  await assert.rejects(installFresh(options), /integrity failure/);
  await assert.rejects(readFile(path.join(options.target, ".setup-pending/prepared.json")), {
    code: "ENOENT",
  });
});

test("legacy and recovery packages preserve an existing recovery directory", async () => {
  for (const create of [fixture, recoveryFixture]) {
    const options = await create();
    await mkdir(path.join(options.target, "recovery"));
    await writeFile(path.join(options.target, "recovery/evidence.json"), "retain");
    await assert.rejects(installFresh(options), /Existing installation entry: recovery/);
    assert.equal(
      await readFile(path.join(options.target, "recovery/evidence.json"), "utf8"),
      "retain",
    );
    await assert.rejects(readFile(path.join(options.target, ".setup-pending/prepared.json")), {
      code: "ENOENT",
    });
  }
});

test("redirected recovery payload is rejected before installation", async () => {
  const options = await fixture();
  await symlink(
    options.target,
    path.join(options.source, "recovery"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(inventoryTree(options.source), /Redirected payload/);
  await assert.rejects(installFresh(options), /Redirected payload/);
  await assert.rejects(readFile(path.join(options.target, ".setup-pending/prepared.json")), {
    code: "ENOENT",
  });
});

test("fresh publication preserves user state and rejects a second install", async () => {
  const options = await fixture();
  await installFresh(options);
  assert.deepEqual(await inventoryTree(options.target), options.inventory);
  assert.equal(
    await readFile(path.join(options.target, "workspace-core/registry.json"), "utf8"),
    "user data",
  );
  await assert.rejects(installFresh(options), /Existing installation/);
});

for (const interruption of [
  "prepared",
  "before:versions",
  "before:bin",
  "before:HoneyBeeLauncher.exe",
  "before:current.json",
]) {
  test(`interruption at ${interruption} cannot activate partial files or overwrite evidence`, async () => {
    const options = await fixture();
    await assert.rejects(
      installFresh({
        ...options,
        checkpoint: async (step) => {
          if (step === interruption) throw new Error("injected interruption");
        },
      }),
      /injected interruption/,
    );
    await assert.rejects(readFile(path.join(options.target, "current.json")), { code: "ENOENT" });
    const evidence = await readFile(
      path.join(options.target, ".setup-pending/prepared.json"),
      "utf8",
    );
    await assert.rejects(installFresh(options));
    assert.equal(
      await readFile(path.join(options.target, ".setup-pending/prepared.json"), "utf8"),
      evidence,
    );
    assert.equal(
      await readFile(path.join(options.target, "workspace-core/registry.json"), "utf8"),
      "user data",
    );
  });
}

test("corrupt or additional payload fails before writing setup state", async () => {
  for (const relative of ["versions/1.0.0/app.exe", "versions/1.0.0/extra.dll"]) {
    const options = await fixture();
    await writeFile(path.join(options.source, relative), "unexpected");
    await assert.rejects(installFresh(options), /integrity failure/);
    await assert.rejects(readFile(path.join(options.target, ".setup-pending/prepared.json")), {
      code: "ENOENT",
    });
  }
});

test("concurrent installers cannot both acquire publication ownership", async () => {
  const options = await fixture();
  const results = await Promise.allSettled([installFresh(options), installFresh(options)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(await inventoryTree(options.target), options.inventory);
});

test("directory redirection is rejected without touching redirected user state", async () => {
  const options = await fixture();
  const redirected = options.target + "-link";
  await symlink(options.target, redirected, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    installFresh({ ...options, target: redirected }),
    /Redirected installation root/,
  );
  await assert.rejects(readFile(path.join(options.target, ".setup-pending/prepared.json")), {
    code: "ENOENT",
  });
});

test("copy failure and source mutation after admission never activate the app", async () => {
  for (const damage of ["missing", "changed"]) {
    const options = await fixture();
    await assert.rejects(
      installFresh({
        ...options,
        checkpoint: async (step) => {
          if (step === "before:versions") {
            const file = path.join(options.source, "versions/1.0.0/app.exe");
            if (damage === "missing") await rename(file, file + ".moved");
            else await writeFile(file, "changed after admission");
          }
        },
      }),
    );
    await assert.rejects(readFile(path.join(options.target, "current.json")), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(options.target, "workspace-core/registry.json"), "utf8"),
      "user data",
    );
  }
});

test("service-only retry requires the exact fully published payload", async () => {
  const options = await fixture();
  await assert.rejects(verifyPublishedSetup(options));
  await installFresh(options);
  await verifyPublishedSetup(options);
  await writeFile(path.join(options.target, "versions/1.0.0/app.exe"), "changed");
  await assert.rejects(verifyPublishedSetup(options), /payload changed/);
});
