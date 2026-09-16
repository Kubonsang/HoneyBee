import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inventoryTree, verifyRepairApplication } from "./fresh-install.mjs";

test("Repair admits the selected release with older versions and preserves user state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-repair-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = "0.1.0-beta.12";
  await mkdir(path.join(root, "versions", version, "desktop"), { recursive: true });
  await mkdir(path.join(root, "bin"));
  const launch = JSON.stringify({ schemaVersion: 1, version });
  await writeFile(path.join(root, "versions", version, "launch.json"), launch);
  await writeFile(path.join(root, "versions", version, "desktop/HoneyBee.exe"), "fixture app");
  await writeFile(path.join(root, "HoneyBeeLauncher.exe"), "fixture launcher");
  await writeFile(path.join(root, "bin/honeybee.exe"), "fixture shim");
  const pointer = {
    schemaVersion: 1,
    activeVersion: version,
    generation: 1,
    manifestSha256: createHash("sha256").update(launch).digest("hex"),
  };
  await writeFile(path.join(root, "current.json"), JSON.stringify(pointer));
  const inventory = await inventoryTree(root);
  await mkdir(path.join(root, "versions/0.1.0-beta.11"));
  await writeFile(path.join(root, "versions/0.1.0-beta.11/old.exe"), "preserved old app");
  await mkdir(path.join(root, "workspace-core"));
  const registry = path.join(root, "workspace-core/workspace-registry-v2.json");
  await writeFile(registry, "preserved user bytes");
  await writeFile(path.join(root, "current.json"), JSON.stringify({ ...pointer, generation: 7 }));
  await verifyRepairApplication({ target: root, inventory });
  assert.equal(await readFile(registry, "utf8"), "preserved user bytes");
  await writeFile(path.join(root, "versions", version, "desktop/HoneyBee.exe"), "corrupt");
  await assert.rejects(verifyRepairApplication({ target: root, inventory }), /integrity/);
  await writeFile(
    path.join(root, "current.json"),
    JSON.stringify({ ...pointer, activeVersion: "0.1.0-beta.11" }),
  );
  await assert.rejects(verifyRepairApplication({ target: root, inventory }), /differs from active/);
});
