import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./release-manifest.mjs";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { withInstallationUpdateLock } from "./installation-lock.mjs";
import { requireCombinedClients } from "./combined-admission.mjs";
import { createInstalledValidationDesktop } from "./validation-dispatch.mjs";

const transitions = {
  Prepared: ["ServiceReady", "RollingBack"],
  ServiceReady: ["AppSelected", "RollingBack"],
  AppSelected: ["DesktopReady", "RollingBack"],
  DesktopReady: ["Committing", "RollingBack"],
  Committing: ["Committed", "RollingBack"],
  RollingBack: ["RolledBack"],
  Committed: [],
  RolledBack: [],
};
const required = [
  "admit",
  "prepareService",
  "selectApplication",
  "startValidationDesktop",
  "validateDoctor",
  "commitPair",
  "stopValidationDesktop",
  "restoreService",
  "restoreApplication",
  "validateSource",
  "restartSource",
  "verifyCommitted",
  "assertQuiescent",
  "restartTarget",
  "verifyRelease",
];

/** Internal machine/app bridge; never invoked by ordinary app-only updates yet.
 * Every adapter must be idempotent against its own protected native transaction.
 * Admit must bind this user journal to machine authority; it is not that authority.
 * Validation Desktop must keep normal mutations disabled until commitPair completes. */
export function combinedUpdateIdentity(identity) {
  assert(
    identity &&
      Object.keys(identity).sort().join(",") ===
        ["manifestSha256", "sourcePointerSha256", "serviceTransactionSha256"].sort().join(","),
  );
  for (const digest of Object.values(identity)) assert(/^[a-f0-9]{64}$/u.test(digest));
  const identityBytes = JSON.stringify({
    manifestSha256: identity.manifestSha256,
    sourcePointerSha256: identity.sourcePointerSha256,
    serviceTransactionSha256: identity.serviceTransactionSha256,
  });
  return sha256(identityBytes);
}

export async function readCombinedOutcome({
  installationRoot,
  transactionDirectory,
  sourcePointerSha256,
}) {
  const root = path.resolve(installationRoot),
    directory = path.resolve(transactionDirectory);
  const id = path.basename(directory);
  assert(
    /^[a-f0-9]{64}$/u.test(id) && path.dirname(directory) === path.join(root, "update/combined"),
  );
  await plainDirectory(directory);
  const context = JSON.parse(
    await readBounded(path.join(root, "update/combined-contexts", id + ".json")),
  );
  assert.equal(combinedUpdateIdentity(context.identity), id);
  assert.equal(context.identity.sourcePointerSha256, sourcePointerSha256);
  const names = (await readdir(directory))
    .filter((name) => !/^[a-f0-9-]+\.partial$/u.test(name))
    .sort();
  assert(names.length > 0 && names.length <= 16);
  let state,
    previous = id;
  for (const [index, name] of names.entries()) {
    assert.equal(name, `${String(index + 1).padStart(2, "0")}.json`);
    const bytes = await readBounded(path.join(directory, name));
    const record = JSON.parse(bytes);
    assert(
      record.schemaVersion === 1 &&
        record.identitySha256 === id &&
        record.previousSha256 === previous,
    );
    assert(state ? transitions[state]?.includes(record.state) : record.state === "Prepared");
    state = record.state;
    previous = sha256(bytes);
  }
  assert(["Committed", "RolledBack"].includes(state));
  const selected = Buffer.from(
    state === "Committed" ? context.targetPointer : context.sourcePointer,
    "base64",
  );
  assert.deepEqual(await readBounded(path.join(root, "current.json")), selected);
  return { state, version: JSON.parse(selected).activeVersion };
}

export async function runCombinedUpdate(options, hooks) {
  for (const name of required)
    assert.equal(typeof hooks[name], "function", `Combined ${name} adapter required`);
  const identity = options.identity;
  const identitySha256 = combinedUpdateIdentity(identity);
  return withInstallationUpdateLock(options.installationRoot, async (lease) => {
    await hooks.admit(Object.freeze({ ...identity, identitySha256 }));
    lease.assertHeld();
    const parent = path.join(path.resolve(options.installationRoot), "update", "combined");
    const directory = path.join(parent, identitySha256);
    let entries = [];
    try {
      await plainDirectory(parent);
      await plainDirectory(directory);
      entries = await readdir(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Only fresh transactions require both intact clients. Recovery must still
    // reach protected rollback when a previously admitted target is damaged.
    if (!entries.some((name) => name.endsWith(".json"))) {
      await requireCombinedClients(
        { ...options.clients, installationRoot: options.installationRoot },
        hooks.verifyRelease,
      );
    }
    await mkdir(parent, { recursive: true });
    await plainDirectory(parent);
    await mkdir(directory, { recursive: true });
    await plainDirectory(directory);
    assert(
      entries.length <= 64 &&
        entries.every((name) => /^\d{2}\.json$/u.test(name) || /^[a-f0-9-]+\.partial$/u.test(name)),
      "Unexpected combined journal entry",
    );
    const files = entries.filter((name) => name.endsWith(".json")).sort();
    assert(files.length <= 16, "Combined journal exceeds bound");
    let state,
      previousSha256 = identitySha256,
      count = 0;
    for (const name of files) {
      assert.equal(
        name,
        `${String(count + 1).padStart(2, "0")}.json`,
        "Incomplete combined journal",
      );
      const bytes = await readBounded(path.join(directory, name));
      const record = JSON.parse(bytes);
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.identitySha256, identitySha256);
      assert.equal(record.previousSha256, previousSha256);
      assert(
        state ? transitions[state]?.includes(record.state) : record.state === "Prepared",
        "Invalid combined transition",
      );
      state = record.state;
      previousSha256 = sha256(bytes);
      count++;
    }
    const persist = async (next) => {
      lease.assertHeld();
      assert(state ? transitions[state]?.includes(next) : next === "Prepared");
      const bytes =
        JSON.stringify({ schemaVersion: 1, identitySha256, previousSha256, state: next }) + "\n";
      const temporary = path.join(directory, `${randomUUID()}.partial`);
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, path.join(directory, `${String(count + 1).padStart(2, "0")}.json`));
      state = next;
      previousSha256 = sha256(bytes);
      count++;
    };
    if (!state) await persist("Prepared");
    const rollback = async () => {
      if (state !== "RollingBack") await persist("RollingBack");
      await hooks.stopValidationDesktop();
      await hooks.assertQuiescent();
      lease.assertHeld();
      await hooks.restoreApplication();
      // Native rollback requires the source app selection. The pending combined
      // journal keeps ordinary launches blocked while the pair is mismatched.
      lease.assertHeld();
      await hooks.restoreService();
      assert.equal(await hooks.validateSource(), true, "Restored source health failed");
      await persist("RolledBack");
      await hooks.restartSource();
      return { state, directory };
    };
    const finishCommitted = async () => {
      try {
        await hooks.stopValidationDesktop();
        await hooks.restartTarget();
        return { state, directory, restart: "Dispatched" };
      } catch (error) {
        return { state, directory, restart: "Failed", reason: error.message };
      }
    };
    if (state === "Committed") {
      assert.equal(await hooks.verifyCommitted(), true);
      return finishCommitted();
    }
    if (state === "RolledBack") {
      assert.equal(await hooks.validateSource(), true);
      await hooks.restartSource();
      return { state, directory };
    }
    if (state === "RollingBack") return rollback();
    // Once a protected commit is requested, replay that decision. Never guess
    // rollback after a crash that may have already committed the machine side.
    if (state === "Committing") {
      try {
        if (options.recover === true) {
          const ready = await hooks.startValidationDesktop();
          assert(
            ready?.ready === true &&
              ready.mode === "update-validation" &&
              ready.validationId === identitySha256,
          );
          assert.equal(await hooks.validateDoctor(), true);
        }
        await hooks.commitPair();
        assert.equal(await hooks.verifyCommitted(), true);
        await persist("Committed");
        return finishCommitted();
      } catch (error) {
        // A missing user outcome never authorizes rollback. The machine must
        // atomically refuse future commit and attest no commit decision exists.
        if (
          typeof hooks.authorizeUncommittedRollback !== "function" ||
          (await hooks.authorizeUncommittedRollback()) !== true
        )
          throw error;
        return { ...(await rollback()), reason: error.message };
      }
    }
    if (options.recover === true) return rollback();
    let checkedReady = false;
    try {
      if (state === "Prepared") {
        await hooks.assertQuiescent();
        await hooks.prepareService();
        await persist("ServiceReady");
      }
      if (state === "ServiceReady") {
        await hooks.assertQuiescent();
        await hooks.selectApplication();
        await persist("AppSelected");
      }
      if (state === "AppSelected") {
        const ready = await hooks.startValidationDesktop();
        assert(
          ready?.ready === true &&
            ready.mode === "update-validation" &&
            ready.validationId === identitySha256,
          "Isolated Desktop readiness required",
        );
        assert.equal(await hooks.validateDoctor(), true, "Combined Doctor validation failed");
        await persist("DesktopReady");
        checkedReady = true;
      }
      // Repeat readiness after a reboot even if its previous check was recorded.
      if (state === "DesktopReady" && !checkedReady) {
        const ready = await hooks.startValidationDesktop();
        assert(
          ready?.ready === true &&
            ready.mode === "update-validation" &&
            ready.validationId === identitySha256,
        );
        assert.equal(await hooks.validateDoctor(), true);
      }
      await persist("Committing");
    } catch (error) {
      const result = await rollback();
      return { ...result, reason: error.message };
    }
    await hooks.commitPair();
    assert.equal(await hooks.verifyCommitted(), true);
    await persist("Committed");
    return finishCommitted();
  });
}

/** Composition for installed candidates. Native migration, paired pointer
 * selection and protected recovery adapters remain required; there is no mock
 * fallback when service integration or signing inputs are unavailable. */
export function runInstalledCombinedUpdate(options, hooks) {
  assert.equal(typeof hooks.authorizeCandidate, "function");
  assert.equal(
    path.resolve(options.clients.targetDirectory),
    path.join(path.resolve(options.installationRoot), "versions", options.validation.version),
    "Validation candidate differs from admitted target",
  );
  const transport = createInstalledValidationDesktop(
    {
      ...options.validation,
      installationRoot: options.installationRoot,
      launcherSha256: options.clients.launcherSha256,
      validationId: combinedUpdateIdentity(options.identity),
    },
    { authorize: hooks.authorizeCandidate, verifyRelease: hooks.verifyRelease },
  );
  assert.equal(typeof hooks.setValidationActivityMode, "function");
  const stop = async () => {
    await transport.stopValidationDesktop();
    // Waiting for exclusive admission proves the validation process released
    // its shared lease before service/pointer mutation or commit.
    await hooks.setValidationActivityMode("exclusive");
  };
  return runCombinedUpdate(options, {
    ...hooks,
    ...transport,
    startValidationDesktop: async () => {
      assert.equal(await hooks.authorizeCandidate(), true);
      await hooks.setValidationActivityMode("shared");
      return transport.startValidationDesktop();
    },
    stopValidationDesktop: stop,
    commitPair: async () => {
      await stop();
      await hooks.commitPair();
    },
  });
}
