import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { withApplicationActivity } from "./application-activity.mjs";
import { activatePublishedUpdateWithDoctor } from "./doctor-update.mjs";

/** Internal composition. The shutdown adapter must address the intended Desktop,
 * honor AbortSignal, and return its response, never infer consent from process exit.
 * All relevant clients must participate; the gate alone does not prove that fact. */
export const withDesktopUpdateLifecycle = async (options, hooks, activate) => {
  options = { ...options };
  hooks = { ...hooks };
  assert(typeof activate === "function", "Activation operation required");
  assert(typeof hooks.requestShutdown === "function", "Desktop shutdown adapter required");
  assert(typeof hooks.authorizeRestart === "function", "Restart authorization required");
  const root = path.resolve(options.installationRoot);
  const timeout = options.shutdownTimeoutMs ?? 60000;
  assert(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 120000);
  assert(/^[a-f0-9]{64}$/u.test(options.sourcePointerSha256), "Source pointer pin required");
  assert(/^[a-f0-9]{64}$/u.test(options.launcherSha256), "Trusted launcher pin required");
  const launcher = path.join(root, "HoneyBeeLauncher.exe");
  const verifyLauncher = async () =>
    assert.equal(sha256(await readBounded(launcher, 8 * 1024 * 1024)), options.launcherSha256);
  const source = await readBounded(path.join(root, "current.json"));
  assert.equal(sha256(source), options.sourcePointerSha256, "Source pointer changed");
  await verifyLauncher();
  const requestId = randomUUID();
  const abort = new globalThis.AbortController();
  let timer;
  let response;
  try {
    response = await Promise.race([
      hooks.requestShutdown(Object.freeze({ root, requestId, signal: abort.signal })),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => {
          abort.abort();
          reject(new Error("Desktop shutdown response timed out"));
        }, timeout);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
    abort.abort();
  }
  assert(response?.requestId === requestId, "Unrelated shutdown response");
  assert(["accepted", "cancelled"].includes(response.status), "Invalid shutdown response");
  if (response.status === "cancelled") return { state: "Cancelled", restart: "NotRequested" };
  const completed = await withApplicationActivity(
    { installationRoot: root, mode: "exclusive", timeoutMs: options.drainTimeoutMs ?? 60000 },
    async (lease) => {
      assert.deepEqual(await readBounded(path.join(root, "current.json")), source);
      const result = await activate(lease);
      lease.assertHeld();
      assert(["Committed", "RolledBack"].includes(result.state), "Nonterminal activation result");
      const pointer = await readBounded(path.join(root, "current.json"));
      lease.assertHeld();
      return { result, pointer };
    },
  );
  // Desktop needs shared admission, so release exclusive activity before launch.
  // Restart errors must never rewrite a successfully committed/rolled-back pointer.
  try {
    const identity = Object.freeze({
      root,
      state: completed.result.state,
      pointerSha256: sha256(completed.pointer),
    });
    assert.equal(await hooks.authorizeRestart(identity), true, "Restart authorization refused");
    assert.deepEqual(await readBounded(path.join(root, "current.json")), completed.pointer);
    await verifyLauncher();
    await hooks.prepareRestart?.();
    const dispatch =
      hooks.dispatchLauncher ??
      (async ({ executable, cwd }) => {
        await promisify(execFile)(executable, [], { cwd, windowsHide: true, timeout: 15000 });
      });
    await dispatch(Object.freeze({ executable: launcher, cwd: root }));
    if (hooks.waitForReady !== undefined) {
      const version = JSON.parse(completed.pointer).activeVersion;
      const desktop = await hooks.waitForReady(Object.freeze({ root, version }));
      assert(
        desktop?.version === version && desktop.readiness === "renderer-loaded",
        "Wrong Desktop readiness",
      );
      assert.deepEqual(await readBounded(path.join(root, "current.json")), completed.pointer);
      return { ...completed.result, restart: "Ready", desktop };
    }
    return { ...completed.result, restart: "Dispatched" };
  } catch (error) {
    return { ...completed.result, restart: "Failed", restartError: error.message };
  }
};

/** No default shutdown, trust, or health authorization: not a public update command. */
export const updateAndRestartWithDoctor = (options, hooks = {}) =>
  withDesktopUpdateLifecycle(options, hooks, ({ assertHeld }) =>
    activatePublishedUpdateWithDoctor(options, {
      ...hooks,
      admit: async (context) => {
        assertHeld();
        assert(typeof hooks.admit === "function", "Explicit update admission required");
        const admitted = await hooks.admit(context);
        assertHeld();
        return admitted;
      },
      authorizeHealth: async (context) => {
        assertHeld();
        assert(
          typeof hooks.authorizeHealth === "function",
          "Explicit Doctor authorization required",
        );
        const authorized = await hooks.authorizeHealth(context);
        assertHeld();
        return authorized;
      },
    }),
  );
