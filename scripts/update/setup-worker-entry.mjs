import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import trust from "../../apps/desktop/resources/update-trust-v1.json" with { type: "json" };
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { authenticateSetupDescriptor } from "./setup-descriptor.mjs";
import { readBounded } from "./prepare-release.mjs";
import { inspectSetupRecoverySource, runRecoveryHelper } from "./setup-recovery-runtime.mjs";
import {
  recordRecoveryEvent,
  recoveryJob,
  recoveryEvents,
  setupRecoveryRoute,
  terminalRecoveryStates,
  withSetupRecoveryLock,
} from "./setup-recovery.mjs";
import {
  createSetupDesktopUpdateTransport,
  readDesktopSession,
  requestDesktopSession,
} from "./desktop-session.mjs";
import { parseDoctorHealth } from "./version-health.mjs";
import { sha256 } from "./release-manifest.mjs";
import { readUpdateOutcome } from "./update-outcome.mjs";
import { setTimeout as delay } from "node:timers/promises";

// This bundle is shipped outside ASAR, inside the authenticated version inventory.
const releaseRoot = path.resolve(import.meta.dirname, "../../..");
const root = path.resolve(releaseRoot, "../..");
const [jobId, requestSha256] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(path.basename(path.dirname(releaseRoot)), "versions");
const helper = path.join(releaseRoot, "runtime/honeybee-lifecycle.exe");

async function verifyResult(job, expectedVersion) {
  const source = await inspectSetupRecoverySource(root, trust);
  assert.equal(source.currentVersion, expectedVersion);
  const result = await runRecoveryHelper(source.helper, [
    "doctor",
    path.join(source.release, "runtime/node.exe"),
    path.join(source.release, "cli/dist/cli.js"),
    source.release,
    "60000",
  ]);
  assert.equal(
    parseDoctorHealth(JSON.stringify(result)).ready,
    true,
    "Installation Doctor not ready",
  );
  let ready = false;
  const deadline = Date.now() + 30000;
  while (!ready && Date.now() < deadline) {
    const names = await readdir(path.join(root, "update/desktop-sessions"));
    assert(names.length <= 256);
    for (const name of names.filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))) {
      try {
        const session = await readDesktopSession(
          root,
          path.join(root, "update/desktop-sessions", name),
        );
        if (session.mode !== undefined || session.version !== expectedVersion) continue;
        const status = await requestDesktopSession(session, {
          operation: "status",
          timeoutMs: 1000,
        });
        if (status.status === "ready") ready = true;
      } catch {
        /* Disconnected sessions do not prove renderer readiness. */
      }
    }
    if (!ready) await delay(250);
  }
  assert(ready, "Target renderer readiness has not been observed");
  await recordRecoveryEvent(job, "Succeeded", {
    code: "recovery.completed",
    preservation: "unknown",
  });
}

await withSetupRecoveryLock(helper, root, async (assertHeld) => {
  const job = await recoveryJob(root, jobId);
  assert.equal(job.requestSha256, requestSha256);
  assert.equal(
    path.basename(releaseRoot),
    job.request.sourceVersion,
    "Worker belongs to another source",
  );
  const state = (await recoveryEvents(job)).at(-1)?.state;
  assert(
    !terminalRecoveryStates.includes(state) &&
      ["Review", "Starting", "Running", "Verifying", "Unresolved"].includes(state),
  );
  let executed = false;
  try {
    const release = authenticateReleaseManifest(
      await readBounded(path.join(job.directory, "release.json")),
      await readBounded(path.join(job.directory, "release.sig.json"), 4096),
      trust.publicKeys,
    );
    const { descriptor } = authenticateSetupDescriptor(
      await readBounded(path.join(job.directory, "setup.json"), 16384),
      await readBounded(path.join(job.directory, "setup.sig.json"), 4096),
      trust.publicKeys,
      release,
    );
    assert.equal(descriptor.version, job.request.version);
    const current = await readBounded(path.join(root, "current.json"));
    if (sha256(current) !== job.request.sourcePointerSha256) {
      assert.equal(
        JSON.parse(current).activeVersion,
        job.request.version,
        "Installation changed; recovery plan is stale",
      );
      await recordRecoveryEvent(job, "Verifying");
      await verifyResult(job, job.request.version);
      return;
    }
    const source = await inspectSetupRecoverySource(root, trust);
    assert.equal(source.pointerSha256, job.request.sourcePointerSha256);
    assert.equal(
      setupRecoveryRoute({ source, manifest: release.manifest, intent: job.request.intent }),
      job.request.route,
    );
    assertHeld();
    await recordRecoveryEvent(job, "Starting", {
      code: "recovery.approval-step",
      preservation: "unchanged",
    });
    // Repair requires normal Desktop shutdown before any attempt to restore files.
    // Service transition Setup already owns its complete shutdown/rollback lifecycle.
    if (job.request.route === "setup-repair") {
      const transport = await createSetupDesktopUpdateTransport({ installationRoot: root });
      const response = await transport.requestShutdown({
        root,
        requestId: randomUUID(),
        signal: globalThis.AbortSignal.timeout(120000),
      });
      if (response.status === "cancelled") {
        await recordRecoveryEvent(job, "Cancelled", {
          code: "recovery.cancelled",
          preservation: "unchanged",
        });
        return;
      }
      assert.equal(response.status, "accepted");
    }
    assertHeld();
    assert.equal(
      sha256(await readBounded(path.join(root, "current.json"))),
      job.request.sourcePointerSha256,
    );
    await recordRecoveryEvent(job, "Running", {
      code: "recovery.setup-running",
      preservation: "unknown",
    });
    executed = true;
    const result = await runRecoveryHelper(helper, [
      "run-setup",
      path.join(job.directory, "HoneyBeeSetup.exe"),
      descriptor.setup.sha256,
      String(descriptor.setup.size),
      root,
      job.request.route === "setup-repair" ? "repair" : "transition",
    ]);
    assertHeld();
    assert.equal(result.schemaVersion, 1);
    await recordRecoveryEvent(job, "Verifying", {
      exitCode: result.exitCode,
      preservation: "unknown",
    });
    // Exit zero alone is never success. Setup may have rolled back or failed to restart.
    if (result.exitCode !== 0) {
      const outcome = await readUpdateOutcome(root, {
        sourcePointerSha256: job.request.sourcePointerSha256,
        manifestSha256: release.manifestSha256,
      });
      const state =
        outcome?.state === "RolledBack"
          ? "RolledBack"
          : outcome?.state === "UpdateCancelled"
            ? "Cancelled"
            : "Unresolved";
      await recordRecoveryEvent(job, state, {
        code:
          state === "RolledBack"
            ? "recovery.rolled-back"
            : state === "Cancelled"
              ? "recovery.cancelled"
              : "recovery.setup-incomplete",
        preservation: "unknown",
      });
      return;
    }
    await verifyResult(job, job.request.version);
  } catch {
    await recordRecoveryEvent(job, executed ? "Unresolved" : "Blocked", {
      code: executed ? "recovery.verification-required" : "recovery.source-changed",
      preservation: executed ? "unknown" : "unchanged",
    });
    process.exitCode = 1;
  }
});
