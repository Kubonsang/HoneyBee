import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { combinedUpdateIdentity, runInstalledCombinedUpdate } from "./combined-update.mjs";
import { createServiceUpdateSession } from "./service-update-session.mjs";

async function persist(directory, name, value) {
  await mkdir(directory, { recursive: true });
  await plainDirectory(directory);
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  const destination = path.join(directory, name);
  try {
    assert.deepEqual(await readBounded(destination), bytes, "Service bridge receipt changed");
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `${randomUUID()}.partial`);
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await link(temporary, destination);
}

/** Real native adapters for runInstalledCombinedUpdate. Machine authority stays
 * in protected native records; these user receipts let startup find that authority.
 * All workspace/app admission and exclusive activity belong to the coordinator. */
export function createNativeServiceUpdate(
  options,
  { health, sessionFactory = createServiceUpdateSession },
) {
  assert.equal(typeof health, "function", "Authenticated Doctor runner required");
  const root = path.resolve(options.installationRoot);
  const identity = Object.freeze({ ...options.identity });
  const validationId = combinedUpdateIdentity(identity);
  const directory = path.join(root, "update/service-contexts", identity.serviceTransactionSha256);
  assert(/^[a-f0-9]{64}$/u.test(options.targetPointerSha256), "Target selection pin required");
  let session;
  const request = (value) =>
    (session ??= sessionFactory({ executable: options.executable })).request(value);
  let registration;
  const command = (operation, extra = {}) => {
    assert(registration, "Protected native admission missing");
    return request({
      schemaVersion: 1,
      operation,
      transactionSha256: registration.transactionSha256,
      contextSha256: registration.contextSha256,
      ...extra,
    });
  };
  const accept = (value, binding) => {
    assert.deepEqual(
      binding,
      {
        applicationRoot: root,
        sourcePointerSha256: identity.sourcePointerSha256,
        targetPointerSha256: options.targetPointerSha256,
        manifestSha256: identity.manifestSha256,
      },
      "Native service transaction belongs to another application pair",
    );
    assert(value && value.transactionSha256 === identity.serviceTransactionSha256);
    for (const key of ["transactionSha256", "contextSha256", "executableSha256"])
      assert(/^[a-f0-9]{64}$/u.test(value[key]), `Invalid native ${key}`);
    assert(path.isAbsolute(value.executable));
    registration = Object.freeze({ ...value });
  };
  return {
    close: () => session?.close(),
    async admit(binding) {
      assert.deepEqual(binding, { ...identity, identitySha256: validationId });
      let previous;
      try {
        previous = JSON.parse(await readBounded(path.join(directory, "native.json")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (previous || options.recover === true) {
        const result = await request({
          schemaVersion: 1,
          operation: "lookup",
          transactionSha256: identity.serviceTransactionSha256,
        });
        assert.notEqual(result.state, "NotFound", "Protected service transaction is missing");
        accept(result.registration, result.binding);
        if (previous) assert.deepEqual(previous, registration, "Protected native context changed");
      } else {
        const admission = options.admission;
        assert(admission && admission.transactionSha256 === identity.serviceTransactionSha256);
        assert.equal(admission.applicationRoot, root);
        assert.equal(
          sha256(Buffer.from(admission.sourcePointer, "base64")),
          identity.sourcePointerSha256,
        );
        assert.equal(sha256(Buffer.from(admission.manifest, "base64")), identity.manifestSha256);
        assert.equal(admission.ownerPid, process.pid);
        const result = await request({ schemaVersion: 1, operation: "stage", admission });
        assert.equal(result.state, "Prepared");
        accept(result.registration, result.binding);
      }
      await persist(directory, "native.json", registration);
    },
    async prepareService() {
      const result = await command("prepare");
      assert.equal(result.state, "ReadyForAppCommit");
      assert.equal(result.selection, "source");
    },
    async authorizeCandidate() {
      const result = await command("status");
      return (
        ["ReadyForAppCommit", "Committed"].includes(result.state) && result.selection === "target"
      );
    },
    async validateDoctor() {
      const checked = await health("target");
      if (checked.ready !== true) return false;
      // The report is durable before the user journal can enter Committing.
      await persist(
        directory,
        `doctor-${sha256(JSON.stringify(checked.report))}.json`,
        checked.report,
      );
      try {
        await readBounded(path.join(directory, "doctor.json"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await persist(directory, "doctor.json", checked.report);
      }
      return true;
    },
    async commitPair() {
      const bytes = await readBounded(path.join(directory, "doctor.json"));
      const result = await command("commit", {
        desktopValidationId: validationId,
        doctorSha256: sha256(bytes),
      });
      assert.equal(result.state, "Committed");
      assert.equal(result.selection, "target");
    },
    async restoreService() {
      const result = await command("recover");
      assert(
        ["RolledBack", "Resumed", "Failed"].includes(result.state),
        "Service recovery is not complete",
      );
      assert.equal(result.selection, "source");
    },
    async authorizeUncommittedRollback() {
      const result = await command("abort");
      return result.decision === "abort";
    },
    async validateSource() {
      return (await health("source")).ready === true;
    },
    async verifyCommitted() {
      const result = await command("status");
      return (
        result.state === "Committed" &&
        result.selection === "target" &&
        (await health("target")).ready === true
      );
    },
  };
}

export async function runNativeCombinedUpdate(options, hooks) {
  const bridge = createNativeServiceUpdate(
    {
      ...options.native,
      installationRoot: options.installationRoot,
      identity: options.identity,
      recover: options.recover,
      targetPointerSha256: options.validation.targetPointerSha256,
    },
    { health: hooks.health },
  );
  try {
    return await runInstalledCombinedUpdate(options, {
      ...hooks,
      ...bridge,
      admit: async (binding) => {
        assert.equal(await hooks.admit(binding), true, "Combined application admission refused");
        await bridge.admit(binding);
      },
    });
  } finally {
    await bridge.close();
  }
}
