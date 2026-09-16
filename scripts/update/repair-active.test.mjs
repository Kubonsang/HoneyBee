import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareApplicationRepair, recoverApplicationRepair } from "./repair-active.mjs";
import { sha256 } from "./release-manifest.mjs";
import { assertApplicationRepairAdmission } from "../../packages/core/dist/repair-admission.js";

async function fixture() {
  const base = path.resolve("output/repair-active-tests");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "case-"));
  const root = path.join(directory, "installed");
  const source = path.join(directory, "source");
  const version = "0.1.0-beta.12";
  const files = {
    "launch.json": "approved-launch",
    "installation.json": JSON.stringify({ activity: { protocol: 1 } }),
    "desktop/resources/app.asar": "approved-app",
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(source, "versions", version, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await cp(source, root, { recursive: true });
  const pointer = JSON.stringify({
    schemaVersion: 1,
    generation: 4,
    activeVersion: version,
    manifestSha256: sha256(files["launch.json"]),
  });
  await writeFile(path.join(root, "current.json"), pointer);
  await mkdir(path.join(root, "workspace-core"));
  await writeFile(path.join(root, "workspace-core/registry.json"), "preserve-user-state");
  const runtime = path.join(source, "recovery/v1");
  await mkdir(runtime, { recursive: true });
  await writeFile(
    path.join(runtime, "approved-source.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      launchSha256: sha256(files["launch.json"]),
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]),
      ),
    }),
  );
  const app = path.join(root, "versions", version, "desktop/resources/app.asar");
  await writeFile(app, "damaged-app");
  return { root, source, runtime, app, pointer, version };
}

test("damaged app Repair resumes after directory preservation without losing user state", async () => {
  const f = await fixture();
  const options = { installationRoot: f.root, sourceInstallation: f.source, runtime: f.runtime };
  const prepared = await prepareApplicationRepair(options);
  await assert.rejects(assertApplicationRepairAdmission(f.root));
  await assert.rejects(
    recoverApplicationRepair({
      ...options,
      name: prepared.name,
      checkpoint: async (state) => {
        if (state === "preserved") throw new Error("simulated interruption");
      },
    }),
    /simulated interruption/,
  );
  assert.deepEqual(
    await prepareApplicationRepair(options),
    prepared,
    "retry must reuse the durable transaction",
  );
  await recoverApplicationRepair({ ...options, name: prepared.name });
  await assertApplicationRepairAdmission(f.root);
  assert.equal(await readFile(f.app, "utf8"), "approved-app");
  assert.equal(
    await readFile(
      path.join(prepared.directory, "previous-version/desktop/resources/app.asar"),
      "utf8",
    ),
    "damaged-app",
  );
  assert.equal(
    await readFile(path.join(f.root, "workspace-core/registry.json"), "utf8"),
    "preserve-user-state",
  );
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});

test("changed repair staging is refused before the active app is moved", async () => {
  const f = await fixture();
  const options = { installationRoot: f.root, sourceInstallation: f.source, runtime: f.runtime };
  const prepared = await prepareApplicationRepair(options);
  await writeFile(
    path.join(prepared.directory, "candidate/versions", f.version, "desktop/resources/app.asar"),
    "changed-staging",
  );
  await assert.rejects(
    recoverApplicationRepair({ ...options, name: prepared.name }),
    /payload changed/,
  );
  assert.equal(await readFile(f.app, "utf8"), "damaged-app");
  await assert.rejects(assertApplicationRepairAdmission(f.root));
});

test("a published Repair without its completion record finishes on retry", async () => {
  const f = await fixture();
  const options = { installationRoot: f.root, sourceInstallation: f.source, runtime: f.runtime };
  const prepared = await prepareApplicationRepair(options);
  await assert.rejects(
    recoverApplicationRepair({
      ...options,
      name: prepared.name,
      checkpoint: async (state) => {
        if (state === "published") throw new Error("publication interruption");
      },
    }),
    /publication interruption/,
  );
  assert.equal(await readFile(f.app, "utf8"), "approved-app");
  await assert.rejects(assertApplicationRepairAdmission(f.root));
  assert.deepEqual(await prepareApplicationRepair(options), prepared);
  await recoverApplicationRepair({ ...options, name: prepared.name });
  await assertApplicationRepairAdmission(f.root);
});
