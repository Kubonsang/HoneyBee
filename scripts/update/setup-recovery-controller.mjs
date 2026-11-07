import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  authorizeRecoveryWorker,
  cleanRecoveryEnvironment,
  inspectSetupRecoverySource,
} from "./setup-recovery-runtime.mjs";
import {
  discoverSetupRecovery,
  listRecoveryJobs,
  prepareSetupRecovery,
  recordRecoveryEvent,
  recoveryEvents,
  recoveryJob,
  terminalRecoveryStates,
  withSetupRecoveryLock,
} from "./setup-recovery.mjs";

export const idleRecoveryStatus = () => ({
  schemaVersion: 2,
  jobId: null,
  state: "Idle",
  route: null,
  version: null,
  startedAt: null,
  lastProgressAt: null,
  received: null,
  total: null,
  code: null,
  preservation: "unknown",
  userAction: "none",
  canCancel: false,
});
export function recoveryStatusFromJob(job) {
  const event = job.events.at(-1);
  const state = event?.state ?? "Unresolved";
  return {
    ...idleRecoveryStatus(),
    jobId: job.request.jobId,
    state,
    route: job.request.route,
    version: job.request.version,
    startedAt: job.request.createdAt,
    lastProgressAt: event?.at ?? job.request.createdAt,
    code: event?.code ?? null,
    preservation: event?.preservation ?? "unknown",
    userAction:
      state === "Review"
        ? "review"
        : state === "Starting"
          ? "approve-windows"
          : ["Running", "Unresolved"].includes(state)
            ? "check-setup"
            : "none",
    canCancel: state === "Review",
  };
}

/** Public methods accept enum actions and opaque job IDs only; authority stays in Main/Setup. */
export class SetupRecoveryController {
  constructor(options) {
    this.options = options;
    this.state = idleRecoveryStatus();
    this.busy = false;
    this.abort = undefined;
    this.restored = false;
  }
  isBusy() {
    return (
      this.busy ||
      [
        "Checking",
        "Downloading",
        "Review",
        "Starting",
        "Running",
        "Verifying",
        "Unresolved",
      ].includes(this.state.state)
    );
  }
  async status() {
    if (this.busy || !this.options.enabled()) return { ...this.state };
    if (this.restored && this.state.jobId === null) return { ...this.state };
    try {
      const jobs = await listRecoveryJobs(this.options.root());
      const pending = jobs.filter(
        (job) => !terminalRecoveryStates.includes(job.events.at(-1)?.state),
      );
      assert(pending.length <= 1, "Multiple unresolved recovery operations");
      const job = pending[0] ?? jobs.at(-1);
      if (job) {
        this.state = recoveryStatusFromJob(job);
        // An interrupted download cannot become executable merely because a file exists.
        if (this.state.state === "Downloading")
          this.state = {
            ...this.state,
            state: "Unresolved",
            code: "recovery.download-interrupted",
            userAction: "check-setup",
            canCancel: true,
          };
      }
      this.restored = true;
    } catch {
      this.state = {
        ...this.state,
        state: "Unresolved",
        code: "recovery.records-unavailable",
        canCancel: false,
      };
    }
    return { ...this.state };
  }
  async action({ action, jobId }) {
    if (action === "cancel" && this.abort) {
      this.abort.abort();
      return { ...this.state };
    }
    assert(!this.busy, "Recovery operation is already active");
    await this.status();
    assert(this.options.enabled(), "Managed Setup installation required");
    assert(!this.options.applicationBusy(), "An application update is already active");
    if (["prepare-repair", "prepare-update"].includes(action)) {
      assert(jobId === undefined);
      assert(!this.isBusy(), "Resolve the current recovery operation first");
      this.busy = true;
      this.abort = new globalThis.AbortController();
      this.state = {
        ...idleRecoveryStatus(),
        state: "Checking",
        startedAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
        canCancel: true,
      };
      void this.prepare(action === "prepare-repair" ? "repair" : "update");
      return { ...this.state };
    }
    assert(["execute", "resume", "cancel"].includes(action));
    assert(jobId && jobId === this.state.jobId, "Recovery job changed; inspect it again");
    const root = this.options.root(),
      job = await recoveryJob(root, jobId);
    const runtime = await authorizeRecoveryWorker(root, job);
    if (action === "cancel") {
      await withSetupRecoveryLock(runtime.helper, root, async () => {
        const events = await recoveryEvents(job);
        assert(
          ["Review", "Downloading"].includes(events.at(-1)?.state),
          "Running Setup cannot be cancelled here",
        );
        await recordRecoveryEvent(job, "Cancelled", {
          code: "recovery.cancelled",
          preservation: "unchanged",
        });
      });
      return this.status();
    }
    assert(
      action === "execute"
        ? this.state.state === "Review"
        : ["Starting", "Running", "Verifying", "Unresolved"].includes(this.state.state),
    );
    this.busy = true;
    try {
      await withSetupRecoveryLock(runtime.helper, root, async () => {
        const events = await recoveryEvents(job);
        assert(!terminalRecoveryStates.includes(events.at(-1)?.state));
        if (action === "execute")
          await recordRecoveryEvent(job, "Starting", { code: "recovery.approval-step" });
      });
      // The independent version-scoped worker revalidates everything under its OS lock.
      await new Promise((resolve, reject) => {
        const child = spawn(runtime.executable, [runtime.worker, jobId, job.requestSha256], {
          cwd: path.dirname(runtime.worker),
          env: cleanRecoveryEnvironment(),
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      this.state = {
        ...this.state,
        state: action === "execute" ? "Starting" : this.state.state,
        canCancel: false,
        userAction: action === "execute" ? "approve-windows" : "check-setup",
      };
    } finally {
      this.busy = false;
    }
    return { ...this.state };
  }
  async prepare(intent) {
    const abort = this.abort;
    try {
      const root = this.options.root();
      const source = await inspectSetupRecoverySource(root, this.options.trust);
      assert(source.identityVerified, "Installation owner or integrity could not be verified");
      abort.signal.throwIfAborted();
      await mkdir(path.join(root, "update"), { recursive: true });
      await withSetupRecoveryLock(source.helper, root, async (assertHeld) => {
        const offer = await discoverSetupRecovery({
          source,
          intent,
          trustedPublicKeys: this.options.trust.publicKeys,
          signal: abort.signal,
        });
        assertHeld();
        if (offer.route === "application-update") {
          this.state = {
            ...this.state,
            state: "Blocked",
            code: "recovery.use-app-update",
            version: offer.release.manifest.version,
            route: "application-update",
            canCancel: false,
          };
          return;
        }
        this.state = {
          ...this.state,
          state: "Downloading",
          route: offer.route,
          version: offer.release.manifest.version,
        };
        const job = await prepareSetupRecovery({
          root,
          source,
          intent,
          offer,
          signal: abort.signal,
          onProgress: ({ jobId, received, total }) => {
            assertHeld();
            this.state = {
              ...this.state,
              jobId,
              received,
              total,
              lastProgressAt: new Date().toISOString(),
            };
          },
        });
        assertHeld();
        this.state = recoveryStatusFromJob({ ...job, events: await recoveryEvents(job) });
      });
    } catch {
      this.state = {
        ...this.state,
        state: abort.signal.aborted ? "Cancelled" : "Failed",
        code: abort.signal.aborted ? "recovery.cancelled" : "recovery.prepare-failed",
        canCancel: false,
        preservation: "unchanged",
        userAction: "none",
      };
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }
}
