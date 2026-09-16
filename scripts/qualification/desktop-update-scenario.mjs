import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDesktopUpdateTransport,
  readDesktopSession,
  requestDesktopSession,
} from "../update/desktop-session.mjs";
import { updateAndRestartWithDoctor } from "../update/desktop-update-lifecycle.mjs";
import { withApplicationActivity } from "../update/application-activity.mjs";
import { sha256 } from "../update/release-manifest.mjs";

/** VM-only fixture UI with real session transport, activation, and Doctor hooks. */
export const runDesktopUpdateScenario = async (config, hooks, pin) => {
  const root = config.options.installationRoot;
  const sessions = path.join(root, "update/desktop-sessions");
  await mkdir(sessions, { recursive: true });
  const logs = new Map();
  const launch = async (entry) => {
    const profile = path.join(root, "qa-desktop", entry);
    await mkdir(profile, { recursive: true });
    const env = {
      ...process.env,
      TEMP: profile,
      TMP: profile,
      HONEYBEE_DESKTOP_SMOKE: "desktop-smoke-v2",
      HONEYBEE_DESKTOP_SESSION_SMOKE: "session-v1",
      HONEYBEE_DESKTOP_SMOKE_RESULT: path.join(profile, "smoke.json"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const executable =
      entry === "source" && config.mode !== "recovery-only"
        ? path.join(root, "versions", pin.version, "desktop/HoneyBee.exe")
        : path.join(root, "HoneyBeeLauncher.exe");
    const child = spawn(
      executable,
      [
        "--user-data-dir=" + profile,
        "--disable-gpu",
        "--disable-gpu-sandbox",
        "--disable-software-rasterizer",
        "--no-sandbox",
      ],
      { cwd: profile, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    logs.set(entry, "");
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (b) => logs.set(entry, (logs.get(entry) + b.toString()).slice(-65536)));
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  };
  try {
    await launch("source");
    let source;
    const deadline =
      Date.now() + (pin.startupRecovery && config.mode === "recovery-only" ? 210000 : 30000);
    while (!source && Date.now() < deadline) {
      for (const name of await readdir(sessions)) {
        try {
          const session = await readDesktopSession(root, path.join(sessions, name));
          if (
            session.version === pin.version &&
            (await requestDesktopSession(session, { operation: "status", timeoutMs: 1000 }))
              .status === "ready"
          ) {
            source = session;
            break;
          }
        } catch {
          /* Partial startup files do not establish readiness. */
        }
      }
      if (!source) await delay(100);
    }
    assert(source, "Source Desktop readiness timeout");
    if (config.mode === "recovery-only")
      return { version: source.version, readiness: "renderer-loaded", sessionId: source.sessionId };
    const transport = await createDesktopUpdateTransport({
      installationRoot: root,
      descriptor: path.join(sessions, source.sessionId + ".json"),
    });
    const options = {
      ...config.options,
      sourcePointerSha256: sha256(await readFile(path.join(root, "current.json"))),
      launcherSha256: pin.launcherSha256,
    };
    const result = await updateAndRestartWithDoctor(options, {
      ...hooks,
      ...transport,
      // Explicitly a coordinator cancellation test: do not send a shutdown request.
      ...(config.mode === "cancel"
        ? { requestShutdown: async ({ requestId }) => ({ requestId, status: "cancelled" }) }
        : {}),
      authorizeRestart: async () => {
        await hooks.admit();
        return true;
      },
      dispatchLauncher: async () => {
        if (config.mode === "restart-failure")
          throw new Error("QA injected launcher dispatch failure");
        await launch("restart");
      },
    });
    if (config.mode === "cancel") {
      assert.equal(result.state, "Cancelled");
      assert.equal((await requestDesktopSession(source, { operation: "status" })).status, "ready");
    } else if (config.mode === "restart-failure") {
      assert.equal(result.state, "Committed");
      assert.equal(result.restart, "Failed");
    } else {
      assert.equal(result.restart, "Ready");
      assert.equal(
        result.desktop.version,
        config.mode === "rollback" ? pin.version : pin.targetVersion,
      );
      assert.notEqual(result.desktop.sessionId, source.sessionId);
    }
    return result;
  } finally {
    // This root is a fresh isolated case; never send requests to the user's installation.
    for (const name of await readdir(sessions)) {
      try {
        const session = await readDesktopSession(root, path.join(sessions, name));
        await requestDesktopSession(session, { operation: "shutdown", timeoutMs: 5000 });
      } catch {
        /* Disconnected/stale sessions are retained for evidence. */
      }
    }
    for (const [entry, text] of logs)
      await writeFile(path.join(root, "qa-desktop", entry, "process.log"), text);
    await withApplicationActivity(
      { installationRoot: root, mode: "exclusive", timeoutMs: 10000 },
      async ({ assertHeld }) => assertHeld(),
    );
  }
};
