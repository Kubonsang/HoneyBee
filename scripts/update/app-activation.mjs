import { readValidationJournal } from "./update-transaction.mjs";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { withInstallationUpdateLock } from "./installation-lock.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { readBounded } from "./prepare-release.mjs";
import { sha256, compareVersions } from "./release-manifest.mjs";

const writeSynced = async (name, bytes) => {
  const file = await open(name, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
};
const pointer = (bytes) => {
  const value = JSON.parse(bytes);
  assert.deepEqual(Object.keys(value).sort(), [
    "activeVersion",
    "generation",
    "manifestSha256",
    "schemaVersion",
  ]);
  assert(
    value.schemaVersion === 1 && Number.isSafeInteger(value.generation) && value.generation > 0,
    "Invalid pointer generation",
  );
  compareVersions(value.activeVersion, "0.0.0");
  assert(/^[a-f0-9]{64}$/u.test(value.manifestSha256), "Invalid launch pin");
  return value;
};
const verifyVersion = async (root, bytes) => {
  const current = pointer(bytes),
    directory = path.join(root, "versions", current.activeVersion);
  await plainDirectory(directory);
  const launchBytes = await readBounded(path.join(directory, "launch.json"));
  assert.equal(sha256(launchBytes), current.manifestSha256, "Launch manifest changed");
  const launch = JSON.parse(launchBytes);
  assert.deepEqual(
    Object.keys(launch).sort(),
    [
      "schemaVersion",
      "version",
      "desktopSha256",
      "nodeSha256",
      "cliSha256",
      "installationSha256",
    ].sort(),
    "Unsupported launch fields",
  );
  assert(
    launch.schemaVersion === 1 && launch.version === current.activeVersion,
    "Wrong launch identity",
  );
  for (const [name, expected] of [
    ["desktop/HoneyBee.exe", launch.desktopSha256],
    ["runtime/node.exe", launch.nodeSha256],
    ["cli/dist/cli.js", launch.cliSha256],
    ["installation.json", launch.installationSha256],
  ]) {
    assert(
      typeof expected === "string" && /^[a-f0-9]{64}$/u.test(expected),
      "Missing launch digest",
    );
    const file = path.join(directory, name);
    await plainDirectory(path.dirname(file));
    const info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink(), "Redirected executable");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    assert.equal(digest.digest("hex"), expected, "Version file changed");
  }
  const installation = JSON.parse(await readBounded(path.join(directory, "installation.json")));
  assert(
    installation.schemaVersion === 1 &&
      installation.version === current.activeVersion &&
      typeof installation.componentVersion === "string" &&
      installation.componentVersion.length > 0,
    "Invalid installed component",
  );
  return { directory, componentVersion: installation.componentVersion };
};
const exists = async (name) => {
  try {
    await lstat(name);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
/** Checks one explicit version without consulting or changing the active pointer. */
export const verifyAppVersion = async ({ installationRoot, version, launchManifestSha256 }) =>
  verifyVersion(
    path.resolve(installationRoot),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        activeVersion: version,
        manifestSha256: launchManifestSha256,
      }),
    ),
  );
const load = async (directory) => {
  await plainDirectory(directory);
  const intentBytes = await readBounded(path.join(directory, "intent.json")),
    intent = JSON.parse(intentBytes);
  assert(
    intent.schemaVersion === 1 && intent.kind === "app-pointer-v1",
    "Unsupported activation intent",
  );
  const source = await readBounded(path.join(directory, "source.json"));
  assert.equal(sha256(source), intent.sourcePointerSha256);
  const next = await readBounded(path.join(directory, "target.json"));
  assert.equal(sha256(next), intent.targetPointerSha256);
  const previous = pointer(source),
    target = pointer(next);
  assert(
    Number.isSafeInteger(previous.generation + 1) &&
      target.generation === previous.generation + 1 &&
      compareVersions(target.activeVersion, previous.activeVersion) > 0,
    "Invalid activation generation or version transition",
  );
  const states = [];
  const allowed = ["Switching", "Switched", "Committed", "RollingBack", "RolledBack"];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".state.json")) continue;
    const state = name.slice(0, -11);
    assert(allowed.includes(state), "Unknown activation state");
    const record = JSON.parse(await readBounded(path.join(directory, name)));
    assert(
      record.schemaVersion === 1 &&
        record.state === state &&
        record.intentSha256 === sha256(intentBytes),
      "Invalid activation state",
    );
    states.push(state);
  }
  assert(
    !(states.includes("Committed") && states.includes("RolledBack")),
    "Conflicting activation outcome",
  );
  assert(
    !states.includes("Switched") || states.includes("Switching"),
    "Switched without intent to switch",
  );
  assert(
    !states.includes("Committed") ||
      (states.includes("Switched") && !states.includes("RollingBack")),
    "Invalid commit history",
  );
  assert(
    !states.includes("RolledBack") || states.includes("RollingBack"),
    "Rollback completion without intent",
  );
  return { intent, source, next, intentSha256: sha256(intentBytes), states };
};
const mark = async (directory, snapshot, state, assertHeld) => {
  assertHeld();
  const name = path.join(directory, `${state}.state.json`);
  const data =
    JSON.stringify({ schemaVersion: 1, state, intentSha256: snapshot.intentSha256 }) + "\n";
  if (await exists(name)) {
    assert.equal((await readBounded(name)).toString(), data);
    return;
  }
  await writeSynced(name, data);
};

/** Read-only terminal outcome for Desktop display. Does not authorize execution. */
export async function readActivationOutcome({
  installationRoot,
  transactionDirectory,
  sourcePointerSha256,
}) {
  const root = path.resolve(installationRoot),
    directory = path.resolve(transactionDirectory);
  assert.equal(path.dirname(directory), path.join(root, "update/activations"));
  assert(/^activation-[A-Za-z0-9]+$/u.test(path.basename(directory)));
  await plainDirectory(directory);
  const snapshot = await load(directory);
  assert.equal(snapshot.intent.sourcePointerSha256, sourcePointerSha256);
  const committed = snapshot.states.includes("Committed");
  assert(committed || snapshot.states.includes("RolledBack"), "Activation has no terminal outcome");
  const expected = committed ? snapshot.next : snapshot.source;
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    expected,
    "Outcome is not the current installation",
  );
  return {
    state: committed ? "Committed" : "RolledBack",
    version: pointer(expected).activeVersion,
  };
}
const replacePointer = async (root, expected, replacement, assertHeld) => {
  assertHeld();
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    expected,
    "Current pointer changed outside activation",
  );
  const temporary = path.join(root, `.current-${randomUUID()}.partial`);
  await writeSynced(temporary, replacement);
  assertHeld();
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    expected,
    "Current pointer changed before replacement",
  );
  await rename(temporary, path.join(root, "current.json"));
};
const rollback = async (root, directory, snapshot, assertHeld, health) => {
  const current = await readBounded(path.join(root, "current.json"));
  assert(
    current.equals(snapshot.source) || current.equals(snapshot.next),
    "Unknown active pointer; refusing rollback",
  );
  await verifyVersion(root, snapshot.source);
  assert.equal(
    await health({ root, phase: "rollback", version: pointer(snapshot.source).activeVersion }),
    true,
    "Previous version recovery health failed",
  );
  await mark(directory, snapshot, "RollingBack", assertHeld);
  if (current.equals(snapshot.next))
    await replacePointer(root, snapshot.next, snapshot.source, assertHeld);
  await mark(directory, snapshot, "RolledBack", assertHeld);
  return { state: "RolledBack", transactionDirectory: directory };
};
const assertHooks = (hooks) => {
  assert(
    typeof hooks.admit === "function" && typeof hooks.health === "function",
    "Explicit admission and health callbacks required; no production executor exists",
  );
};
/** INTERNAL pointer primitive. The caller must authenticate/quiesce/revalidate the complete update under this lock. No default admission. */
export const activateAppPointer = async (options, hooks = {}) => {
  options = { ...options };
  hooks = { ...hooks };
  assertHooks(hooks);
  return withInstallationUpdateLock(options.installationRoot, async ({ assertHeld }) => {
    const root = path.resolve(options.installationRoot),
      parent = path.join(root, "update/activations");
    try {
      await mkdir(parent);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await plainDirectory(parent);
    const validations = path.join(root, "update/transactions");
    if (await exists(validations)) {
      await plainDirectory(validations);
      for (const name of await readdir(validations)) {
        assert(/^txn-[A-Za-z0-9]+$/u.test(name), "Unknown validation transaction");
        const records = await readValidationJournal(path.join(validations, name));
        assert(
          ["Validated", "Abandoned"].includes(records.at(-1)?.state),
          "Interrupted validation must be resolved before activation",
        );
      }
    }
    for (const name of await readdir(parent)) {
      assert(/^activation-[A-Za-z0-9]+$/u.test(name), "Unknown activation entry");
      const prior = await load(path.join(parent, name));
      assert(
        prior.states.includes("Committed") || prior.states.includes("RolledBack"),
        "Interrupted activation must be recovered first",
      );
    }
    const source = await readBounded(path.join(root, "current.json"));
    assert.equal(sha256(source), options.sourcePointerSha256, "Stale source pointer");
    const old = pointer(source);
    assert(compareVersions(options.targetVersion, old.activeVersion) > 0, "Target must be newer");
    assert(Number.isSafeInteger(old.generation + 1), "Generation overflow");
    const next = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        generation: old.generation + 1,
        activeVersion: options.targetVersion,
        manifestSha256: options.targetManifestSha256,
      }) + "\n",
    );
    const previous = await verifyVersion(root, source),
      target = await verifyVersion(root, next);
    assert.equal(
      previous.componentVersion,
      target.componentVersion,
      "Service migration cannot use app-only activation",
    );
    const context = {
      root,
      sourceVersion: old.activeVersion,
      targetVersion: options.targetVersion,
      phase: "activate",
    };
    await hooks.admit(context);
    assertHeld();
    assert.equal(
      await hooks.health({ ...context, phase: "source-health", version: old.activeVersion }),
      true,
      "Previous version is not healthy",
    );
    assert.equal(
      await hooks.health({
        ...context,
        phase: "target-before-switch",
        version: options.targetVersion,
      }),
      true,
      "Target pre-activation health failed",
    );
    const directory = await mkdtemp(path.join(parent, "activation-"));
    await writeSynced(path.join(directory, "source.json"), source);
    await writeSynced(path.join(directory, "target.json"), next);
    await writeSynced(
      path.join(directory, "intent.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "app-pointer-v1",
        sourcePointerSha256: sha256(source),
        targetPointerSha256: sha256(next),
      }) + "\n",
    );
    const snapshot = await load(directory),
      checkpoint = hooks.checkpoint ?? (async () => {});
    try {
      await checkpoint("intent", directory);
      await mark(directory, snapshot, "Switching", assertHeld);
      await replacePointer(root, source, next, assertHeld);
      await checkpoint("switched", directory);
      await mark(directory, snapshot, "Switched", assertHeld);
      assert.equal(
        await hooks.health({
          ...context,
          phase: "target-after-switch",
          version: options.targetVersion,
        }),
        true,
        "Target post-activation health failed",
      );
      await verifyVersion(root, next);
      await checkpoint("validated", directory);
      assert.deepEqual(
        await readBounded(path.join(root, "current.json")),
        next,
        "Active pointer changed during health check",
      );
      await mark(directory, snapshot, "Committed", assertHeld);
      return { state: "Committed", transactionDirectory: directory };
    } catch (error) {
      try {
        return {
          ...(await rollback(root, directory, snapshot, assertHeld, hooks.health)),
          reason: error.message,
        };
      } catch (cause) {
        throw new Error(`Activation needs recovery: ${directory}`, { cause });
      }
    }
  });
};
export const recoverAppPointer = async (options, hooks = {}) => {
  options = { ...options };
  hooks = { ...hooks };
  assertHooks(hooks);
  return withInstallationUpdateLock(options.installationRoot, async ({ assertHeld }) => {
    const root = path.resolve(options.installationRoot),
      directory = path.resolve(options.transactionDirectory);
    assert(
      path.dirname(directory) === path.join(root, "update/activations") &&
        /^activation-[A-Za-z0-9]+$/u.test(path.basename(directory)),
      "Recovery directory outside installation",
    );
    const snapshot = await load(directory);
    assert.equal(
      snapshot.intent.sourcePointerSha256,
      options.sourcePointerSha256,
      "Recovery source pin mismatch",
    );
    const target = pointer(snapshot.next);
    assert.equal(target.activeVersion, options.targetVersion);
    assert.equal(target.manifestSha256, options.targetManifestSha256);
    const context = {
      root,
      phase: "recover",
      sourceVersion: pointer(snapshot.source).activeVersion,
      targetVersion: target.activeVersion,
    };
    await hooks.admit(context);
    assertHeld();
    if (snapshot.states.includes("Committed") || snapshot.states.includes("RolledBack")) {
      const committed = snapshot.states.includes("Committed"),
        expected = committed ? snapshot.next : snapshot.source;
      assert.deepEqual(
        await readBounded(path.join(root, "current.json")),
        expected,
        "Terminal activation pointer changed",
      );
      await verifyVersion(root, expected);
      assert.equal(
        await hooks.health({
          ...context,
          phase: committed ? "committed-health" : "rolled-back-health",
          version: pointer(expected).activeVersion,
        }),
        true,
        "Terminal activation health failed",
      );
      await verifyVersion(root, expected);
      assert.deepEqual(
        await readBounded(path.join(root, "current.json")),
        expected,
        "Terminal pointer changed during health check",
      );
      return { state: committed ? "Committed" : "RolledBack", transactionDirectory: directory };
    }
    return rollback(root, directory, snapshot, assertHeld, hooks.health);
  });
};
