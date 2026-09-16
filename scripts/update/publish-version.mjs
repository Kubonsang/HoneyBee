import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, stat, link, unlink } from "node:fs/promises";
import path from "node:path";
import { withInstallationUpdateLock } from "./installation-lock.mjs";
import { revalidateUpdatePlan } from "./update-plan.mjs";
import { readBounded, validatePreparedPayload } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { parseReleaseManifest, sha256 } from "./release-manifest.mjs";
const exists = async (file) => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const record = async (directory, name, value) => {
  const file = await open(path.join(directory, name), "wx");
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
};
const identity = async (directory) => {
  await plainDirectory(directory);
  const info = await stat(directory, { bigint: true });
  assert(info.ino !== 0n, "Directory identity unavailable");
  return { device: String(info.dev), fileId: String(info.ino) };
};
/** Read-only verification under the caller's installation lock; never resumes copying. */
export const verifyPublishedVersion = async (options) => {
  const root = path.resolve(options.installationRoot);
  const planBytes = await readBounded(options.planPath);
  assert.equal(sha256(planBytes), options.planSha256, "Plan SHA-256 mismatch");
  const plan = JSON.parse(planBytes);
  assert(
    plan.schemaVersion === 1 &&
      plan.state === "Planned" &&
      plan.activationAllowed === false &&
      (plan.identity.status === "app-only-candidate" ||
        (options.allowServiceCandidate === true && plan.identity.status === "migration-required")),
    "Unsupported publication plan",
  );
  for (const [name, prefix] of [
    [plan.prepareAttempt, "prepare"],
    [plan.stageAttempt, "stage"],
  ])
    assert(new RegExp(`^${prefix}-[A-Za-z0-9]+$`, "u").test(name), "Invalid plan attempt");
  const attempt = path.join(root, "update", plan.prepareAttempt);
  assert.equal(path.resolve(options.planPath), path.join(attempt, "plan.json"));
  await plainDirectory(attempt);
  const stage = path.join(root, "update", plan.stageAttempt);
  await plainDirectory(stage);
  const manifest = parseReleaseManifest(
    await readBounded(path.join(stage, "release.json")),
    plan.manifestSha256,
  );
  const inventoryBytes = await readBounded(path.join(attempt, "inventory.json"), 8 * 1024 * 1024);
  assert.equal(sha256(inventoryBytes), plan.inventorySha256);
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.schemaVersion, 1);
  const directory = path.resolve(options.publicationDirectory);
  assert(
    path.dirname(directory) === path.join(root, "update/publications") &&
      /^publish-[A-Za-z0-9]+$/u.test(path.basename(directory)),
    "Publication outside installation",
  );
  await plainDirectory(directory);
  assert.deepEqual(JSON.parse(await readBounded(path.join(directory, "Intent.json"))), {
    schemaVersion: 1,
    kind: "exclusive-files-v1",
    planPath: path.resolve(options.planPath),
    planSha256: options.planSha256,
    version: manifest.version,
    activationAllowed: false,
  });
  const target = path.join(root, "versions", manifest.version);
  assert.deepEqual(JSON.parse(await readBounded(path.join(directory, "Reserved.json"))), {
    schemaVersion: 1,
    planSha256: options.planSha256,
    directoryIdentity: await identity(target),
  });
  assert.deepEqual(JSON.parse(await readBounded(path.join(directory, "Published.json"))), {
    schemaVersion: 1,
    state: "Published",
    planSha256: options.planSha256,
    directory: target,
    publicationDirectory: directory,
    activationAllowed: false,
  });
  const metadata = await validatePreparedPayload(target, inventory.files, manifest);
  assert.equal(metadata.launchManifestSha256, plan.launchManifestSha256);
  return { plan, directory: target };
};
const inputs = async (options, dependencies) => {
  const prepared = await revalidateUpdatePlan(options, dependencies);
  const bytes = await readBounded(options.planPath);
  assert.equal(sha256(bytes), options.planSha256);
  const plan = JSON.parse(bytes);
  assert(
    plan.identity.status === "app-only-candidate" ||
      (options.allowServiceCandidate === true && plan.identity.status === "migration-required"),
    "Service migration must use explicit inactive combined publication",
  );
  const inventoryBytes = await readBounded(
    path.join(path.dirname(options.planPath), "inventory.json"),
    8 * 1024 * 1024,
  );
  assert.equal(sha256(inventoryBytes), plan.inventorySha256);
  const manifest = parseReleaseManifest(
    await readBounded(
      path.join(options.installationRoot, "update", plan.stageAttempt, "release.json"),
    ),
    plan.manifestSha256,
  );
  return { prepared, inventory: JSON.parse(inventoryBytes).files, manifest };
};
const verifyFile = async (file, expected) => {
  await plainDirectory(path.dirname(file));
  const info = await lstat(file);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size === expected.size,
    "Publication file differs from pinned inventory",
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest("hex"), expected.sha256, "Publication file digest mismatch");
};
const copyPayload = async (source, target, journal, inventory, checkpoint, assertHeld) => {
  // Publish launch.json last. No active pointer references this reserved directory yet.
  const names = Object.keys(inventory).sort((a, b) =>
    a === "launch.json" ? 1 : b === "launch.json" ? -1 : a.localeCompare(b),
  );
  for (const name of names) {
    assertHeld();
    const expected = inventory[name];
    assert(
      !name.includes("\\") &&
        !name.includes(":") &&
        !path.posix.isAbsolute(name) &&
        name.split("/").every((p) => p !== "" && p !== "." && p !== ".."),
      "Unsafe inventory path",
    );
    const input = path.join(source, name),
      output = path.join(target, name);
    if (await exists(output)) {
      await verifyFile(output, expected);
      continue;
    }
    await verifyFile(input, expected);
    await mkdir(path.dirname(output), { recursive: true });
    await plainDirectory(path.dirname(output));
    const temporary = path.join(journal, `file-${randomUUID()}.partial`),
      file = await open(temporary, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(input)) {
        bytes += chunk.length;
        assert(bytes <= expected.size, "Source grew during publication");
        await file.writeFile(chunk);
        hash.update(chunk);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    assert(
      bytes === expected.size && hash.digest("hex") === expected.sha256,
      "Copy digest mismatch",
    );
    await checkpoint("before-file", journal);
    assertHeld();
    // Same-volume hard-link creation is exclusive: complete bytes appear at once, no overwrite.
    await link(temporary, output);
    await checkpoint("file-linked", journal);
    await unlink(temporary); // Only this call's uniquely-created temporary name is removed.
    await checkpoint("copied", journal);
  }
};
const finish = async (options, dependencies, context, assertHeld, checkpoint) => {
  const { directory, target, reservation, prepared, inventory, manifest } = context;
  assert.deepEqual(
    await identity(target),
    reservation.directoryIdentity,
    "Reserved version directory was replaced",
  );
  if (await exists(path.join(directory, "Published.json"))) {
    await validatePreparedPayload(target, inventory, manifest);
  } else {
    await copyPayload(prepared.directory, target, directory, inventory, checkpoint, assertHeld);
    assertHeld();
    assert.deepEqual(
      await identity(target),
      reservation.directoryIdentity,
      "Reserved version identity changed",
    );
    await validatePreparedPayload(target, inventory, manifest);
    await checkpoint("verified", directory);
  }
  await revalidateUpdatePlan(options, dependencies);
  assertHeld();
  const result = {
    schemaVersion: 1,
    state: "Published",
    planSha256: options.planSha256,
    directory: target,
    publicationDirectory: directory,
    activationAllowed: false,
  };
  if (await exists(path.join(directory, "Published.json")))
    assert.deepEqual(JSON.parse(await readBounded(path.join(directory, "Published.json"))), result);
  else await record(directory, "Published.json", result);
  return result;
};
export const publishPreparedVersion = async (
  options,
  { observe, checkpoint = async () => {} } = {},
) => {
  options = {
    ...options,
    installationRoot: path.resolve(options.installationRoot),
    planPath: path.resolve(options.planPath),
  };
  const dependencies = observe ? { observe } : undefined;
  return withInstallationUpdateLock(options.installationRoot, async ({ assertHeld }) => {
    const input = await inputs(options, dependencies),
      root = options.installationRoot;
    const versions = path.join(root, "versions");
    try {
      await mkdir(versions);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await plainDirectory(versions);
    const target = path.join(versions, input.manifest.version);
    assert(!(await exists(target)), "Existing version will not be overwritten or adopted");
    const parent = path.join(root, "update/publications");
    try {
      await mkdir(parent);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await plainDirectory(parent);
    const directory = await mkdtemp(path.join(parent, "publish-"));
    await record(directory, "Intent.json", {
      schemaVersion: 1,
      kind: "exclusive-files-v1",
      planPath: options.planPath,
      planSha256: options.planSha256,
      version: input.manifest.version,
      activationAllowed: false,
    });
    try {
      await checkpoint("before-reserve", directory);
      assertHeld();
      await mkdir(target);
      const reservation = {
        schemaVersion: 1,
        planSha256: options.planSha256,
        directoryIdentity: await identity(target),
      };
      await record(directory, "Reserved.json", reservation);
      await checkpoint("reserved", directory);
      return await finish(
        options,
        dependencies,
        { ...input, directory, target, reservation },
        assertHeld,
        checkpoint,
      );
    } catch (error) {
      throw new Error(`Publication incomplete; recover the owned reservation at ${directory}`, {
        cause: error,
      });
    }
  });
};
export const recoverVersionPublication = async (
  options,
  { observe, checkpoint = async () => {} } = {},
) => {
  options = {
    ...options,
    installationRoot: path.resolve(options.installationRoot),
    planPath: path.resolve(options.planPath),
  };
  const dependencies = observe ? { observe } : undefined;
  return withInstallationUpdateLock(options.installationRoot, async ({ assertHeld }) => {
    const root = options.installationRoot,
      directory = path.resolve(options.publicationDirectory);
    assert(
      path.dirname(directory) === path.join(root, "update/publications") &&
        /^publish-[A-Za-z0-9]+$/u.test(path.basename(directory)),
      "Publication outside installation",
    );
    await plainDirectory(directory);
    const intent = JSON.parse(await readBounded(path.join(directory, "Intent.json")));
    assert.deepEqual(
      intent,
      {
        schemaVersion: 1,
        kind: "exclusive-files-v1",
        planPath: options.planPath,
        planSha256: options.planSha256,
        version: intent.version,
        activationAllowed: false,
      },
      "Publication plan mismatch",
    );
    const input = await inputs(options, dependencies);
    assert.equal(intent.version, input.manifest.version);
    const reservation = JSON.parse(await readBounded(path.join(directory, "Reserved.json")));
    assert(
      reservation.schemaVersion === 1 && reservation.planSha256 === options.planSha256,
      "Publication reservation unavailable",
    );
    return finish(
      options,
      dependencies,
      {
        ...input,
        directory,
        target: path.join(root, "versions", input.manifest.version),
        reservation,
      },
      assertHeld,
      checkpoint,
    );
  });
};
