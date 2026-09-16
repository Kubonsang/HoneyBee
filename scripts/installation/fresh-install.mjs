import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  copyFile,
} from "node:fs/promises";
import path from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = ["versions", "bin", "HoneyBeeLauncher.exe", "current.json"];
// Older assembled packages have no recovery runtime. When present, it is part
// of the same verified installation, published before the activation pointer.
const optionalEntries = ["recovery"];
const exists = async (target) => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const writeDurable = async (target, value) => {
  const file = await open(target, "wx");
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
};

const inventoryEntries = async (root, selectedEntries) => {
  const result = {};
  const visit = async (relative) => {
    const target = path.join(root, relative);
    const info = await lstat(target);
    assert(!info.isSymbolicLink(), "Redirected payload");
    assert.equal((await realpath(target)).toLowerCase(), path.resolve(target).toLowerCase());
    if (info.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await visit(path.join(relative, name));
    } else {
      assert(info.isFile(), "Non-regular payload");
      result[relative.split(path.sep).join("/")] = digest(await readFile(target));
    }
  };
  for (const entry of selectedEntries) await visit(entry);
  return result;
};

export const inventoryTree = async (root) => {
  const selectedEntries = [...entries];
  for (const entry of optionalEntries)
    if (await exists(path.join(root, entry))) {
      const info = await lstat(path.join(root, entry));
      assert(!info.isSymbolicLink(), "Redirected payload");
      assert(info.isDirectory(), "Recovery must be a directory");
      selectedEntries.push(entry);
    }
  const result = await inventoryEntries(root, selectedEntries);
  for (const entry of selectedEntries.filter((name) => optionalEntries.includes(name)))
    assert(
      Object.keys(result).some((name) => name.startsWith(entry + "/")),
      "Empty recovery payload",
    );
  return result;
};

/** Admission before damaged application bytes are replaced. Repair cannot rely
 * on a damaged Launcher/recovery runtime to recover an interrupted publication. */
export const verifyRepairInfrastructure = async ({ target, inventory }) => {
  const selected = ["bin", "HoneyBeeLauncher.exe", "recovery"];
  assert(
    Object.keys(inventory).some((name) => name.startsWith("recovery/v1/")),
    "Recovery-enabled Setup required for application Repair",
  );
  const expected = Object.fromEntries(
    Object.entries(inventory).filter(([name]) =>
      selected.some((entry) => name === entry || name.startsWith(entry + "/")),
    ),
  );
  assert.deepEqual(
    await inventoryEntries(target, selected),
    expected,
    "Repair requires intact matching bootstrapper and recovery runtime",
  );
};

/** Service Repair admission for the exact active Setup release. Inactive A/B
 * versions and mutable recovery approval records are not application corruption.
 * Corrupt active payloads still fail before installed code executes. */
export const verifyRepairApplication = async ({ target, inventory }) => {
  assert(path.isAbsolute(target));
  const pointer = await readFile(path.join(target, "current.json"));
  const activation = JSON.parse(pointer);
  assert(
    activation.schemaVersion === 1 &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(activation.activeVersion),
  );
  assert.deepEqual(Object.keys(activation).sort(), [
    "activeVersion",
    "generation",
    "manifestSha256",
    "schemaVersion",
  ]);
  assert(Number.isSafeInteger(activation.generation) && activation.generation > 0);
  assert.equal(typeof activation.manifestSha256, "string");
  assert.equal(
    activation.manifestSha256,
    inventory[`versions/${activation.activeVersion}/launch.json`],
    "Repair Setup differs from active release",
  );
  const selected = [
    `versions/${activation.activeVersion}`,
    "bin",
    "HoneyBeeLauncher.exe",
    "current.json",
  ];
  const expected = Object.fromEntries(
    Object.entries(inventory).filter(([name]) =>
      selected.some((entry) => name === entry || name.startsWith(entry + "/")),
    ),
  );
  // Generation increases after updates. Authenticate the selected launch bytes,
  // while preserving and rechecking the exact observed current pointer.
  expected["current.json"] = digest(pointer);
  assert.deepEqual(
    await inventoryEntries(target, selected),
    expected,
    "Active Repair payload integrity failure",
  );
};

/** Fresh application publication only. No service, project, registry or profile mutation. */
export const installFresh = async ({ source, target, inventory, checkpoint = async () => {} }) => {
  assert(
    path.isAbsolute(source) && path.isAbsolute(target),
    "Absolute installation paths required",
  );
  assert.notEqual(path.parse(target).root.toLowerCase(), target.toLowerCase());
  assert.deepEqual(await inventoryTree(source), inventory, "Setup payload integrity failure");
  await mkdir(target, { recursive: true });
  assert.equal(
    (await realpath(target)).toLowerCase(),
    path.resolve(target).toLowerCase(),
    "Redirected installation root",
  );
  for (const entry of [...entries, ...optionalEntries])
    assert(!(await exists(path.join(target, entry))), `Existing installation entry: ${entry}`);
  // Exclusive directory is both the concurrent-installer lock and interruption evidence.
  // Never remove a previous attempt automatically, even if its process no longer exists.
  const pending = path.join(target, ".setup-pending");
  await mkdir(pending);
  await writeDurable(path.join(pending, "prepared.json"), { schemaVersion: 1, inventory });
  await checkpoint("prepared");
  // Version directories are inactive until current.json exists. Copying into these
  // exclusively reserved directories avoids moving trees held by Windows watchers.
  // Every file is exclusive, synced and checked before the sole activation rename.
  const copyVerified = async (relative, destination) => {
    await copyFile(path.join(source, relative), destination, constants.COPYFILE_EXCL);
    const file = await open(destination, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    assert.equal(
      digest(await readFile(destination)),
      inventory[relative],
      "Published payload integrity failure",
    );
  };
  const publicationEntries = [
    ...entries.filter((name) => name !== "current.json"),
    ...optionalEntries.filter((entry) =>
      Object.keys(inventory).some((name) => name.startsWith(entry + "/")),
    ),
  ];
  for (const entry of publicationEntries) {
    await checkpoint(`before:${entry}`);
    const destination = path.join(target, entry);
    assert(!(await exists(destination)), `Installation changed during setup: ${entry}`);
    if (entry === "versions" || entry === "bin" || optionalEntries.includes(entry)) {
      await mkdir(destination);
      for (const relative of Object.keys(inventory).filter((name) =>
        name.startsWith(entry + "/"),
      )) {
        assert(
          !relative.includes("\\") &&
            !relative.split("/").some((part) => part === ".." || part === "." || part === ""),
        );
        const file = path.join(target, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await copyVerified(relative, file);
      }
    } else {
      await copyVerified(entry, destination);
    }
  }
  const pointer = path.join(pending, "current-verified.json");
  await copyVerified("current.json", pointer);
  await writeDurable(path.join(pending, "verified.json"), { schemaVersion: 1 });
  await checkpoint("before:current.json");
  assert(!(await exists(path.join(target, "current.json"))), "Activation changed during setup");
  await rename(pointer, path.join(target, "current.json"));
  await writeDurable(path.join(pending, "published.json"), { schemaVersion: 1 });
  return { pending };
};

/** Admit a service-only retry only for this exact fully published setup payload. */
export const verifyPublishedSetup = async ({ target, inventory }) => {
  const pending = path.join(target, ".setup-pending");
  assert.equal((await realpath(pending)).toLowerCase(), path.resolve(pending).toLowerCase());
  const published = JSON.parse(await readFile(path.join(pending, "published.json"), "utf8"));
  const prepared = JSON.parse(await readFile(path.join(pending, "prepared.json"), "utf8"));
  assert.equal(published.schemaVersion, 1);
  assert.equal(prepared.schemaVersion, 1);
  assert.deepEqual(prepared.inventory, inventory);
  assert.deepEqual(
    await inventoryTree(target),
    inventory,
    "Installed payload changed; service-only retry refused",
  );
  return { pending };
};
