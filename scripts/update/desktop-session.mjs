import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBounded } from "./prepare-release.mjs";
import { updateAndRestartWithDoctor } from "./desktop-update-lifecycle.mjs";

const directory = (root) => path.join(path.resolve(root), "update/desktop-sessions");
export const readDesktopSession = async (root, descriptor) => {
  root = path.resolve(root);
  descriptor = path.resolve(descriptor);
  assert.equal(path.dirname(descriptor), directory(root), "Session outside installation");
  assert.equal(
    (await realpath(descriptor)).toLowerCase(),
    descriptor.toLowerCase(),
    "Redirected session",
  );
  const session = JSON.parse(await readBounded(descriptor, 4096));
  if (session.mode !== undefined || session.validationId !== undefined)
    assert(
      session.mode === "update-validation" && /^[a-f0-9]{64}$/u.test(session.validationId),
      "Invalid validation session",
    );
  assert(session.schemaVersion === 1 && /^[a-f0-9-]{36}$/u.test(session.sessionId));
  assert.equal(path.basename(descriptor), session.sessionId + ".json");
  assert.equal(session.root, root);
  assert.equal(session.pipe, `\\\\.\\pipe\\HoneyBee-Desktop-${session.sessionId}`);
  assert(
    typeof session.version === "string" &&
      typeof session.token === "string" &&
      /^[a-f0-9]{64}$/u.test(session.token),
  );
  return session;
};

export const requestDesktopSession = (
  session,
  { operation, requestId = randomUUID(), signal, timeoutMs = 10000 },
) => {
  assert(["status", "shutdown"].includes(operation));
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Desktop request cancelled"));
      return;
    }
    const socket = connect(session.pipe);
    let data = "";
    const abort = () => socket.destroy(new Error("Desktop request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Desktop response timed out")));
    socket.once("error", reject);
    socket.once("close", () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("Desktop disconnected without a response"));
    });
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          token: session.token,
          root: session.root,
          sessionId: session.sessionId,
          requestId,
          operation,
        }) + "\n",
      ),
    );
    socket.on("data", (bytes) => {
      data += bytes.toString();
      if (data.length > 4096) {
        socket.destroy(new Error("Oversized Desktop response"));
        return;
      }
      if (!data.endsWith("\n")) return;
      try {
        const response = JSON.parse(data);
        assert(
          response.schemaVersion === 1 &&
            response.requestId === requestId &&
            response.sessionId === session.sessionId &&
            response.root === session.root &&
            response.version === session.version,
        );
        assert.equal(response.mode, session.mode, "Desktop mode changed");
        assert.equal(
          response.validationId,
          session.validationId,
          "Desktop validation identity changed",
        );
        assert(
          (operation === "status"
            ? ["ready", "starting"]
            : ["accepted", "cancelled", "unavailable"]
          ).includes(response.status),
        );
        resolve(response);
        socket.end();
      } catch {
        socket.destroy(new Error("Invalid Desktop response"));
      }
    });
  });
};

const sessionFiles = async (root) => {
  let names;
  try {
    names = await readdir(directory(root));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  assert(names.length <= 256, "Too many Desktop session records; diagnostics required");
  return names
    .filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))
    .map((name) => path.join(directory(root), name));
};

/** Explicit source descriptor; no PID guessing or broadcast shutdown. */
export const createDesktopUpdateTransport = async ({
  installationRoot,
  descriptor,
  readyTimeoutMs = 30000,
  allowIdle = false,
}) => {
  const root = path.resolve(installationRoot);
  assert(Number.isSafeInteger(readyTimeoutMs) && readyTimeoutMs > 0 && readyTimeoutMs <= 120000);
  assert(descriptor !== undefined || allowIdle === true, "Desktop session required");
  const source = descriptor === undefined ? undefined : await readDesktopSession(root, descriptor);
  let previous;
  return {
    requestShutdown: async ({ root: requestedRoot, requestId, signal }) => {
      assert.equal(path.resolve(requestedRoot), root);
      // This acknowledges an idle Setup request only. The lifecycle must still
      // acquire exclusive activity before changing the application or service.
      if (!source) return { requestId, status: "accepted" };
      return requestDesktopSession(source, {
        operation: "shutdown",
        requestId,
        signal,
        timeoutMs: 120000,
      });
    },
    prepareRestart: async () => {
      previous = new Set(await sessionFiles(root));
    },
    waitForReady: async ({ version }) => {
      assert(previous !== undefined, "Restart session snapshot required");
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        for (const file of await sessionFiles(root)) {
          if (previous.has(file)) continue;
          try {
            const session = await readDesktopSession(root, file);
            if (
              session.mode !== undefined ||
              session.version !== version ||
              session.sessionId === source?.sessionId
            )
              continue;
            const response = await requestDesktopSession(session, {
              operation: "status",
              timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())),
            });
            if (response.status === "ready")
              return { sessionId: session.sessionId, version, readiness: "renderer-loaded" };
          } catch {
            /* Stale, partial, or disconnected records are never readiness. */
          }
          if (Date.now() >= deadline) break;
        }
        await delay(100);
      }
      throw new Error("New Desktop did not report readiness before the deadline");
    },
  };
};

/** Setup can run while Desktop is closed. A live managed Desktop is asked to
 * drain normally; ambiguous sessions are refused before any shutdown request. */
export async function createSetupDesktopUpdateTransport({ installationRoot, readyTimeoutMs }) {
  const root = path.resolve(installationRoot);
  const current = JSON.parse(await readBounded(path.join(root, "current.json")));
  const live = [];
  for (const descriptor of await sessionFiles(root)) {
    let session;
    try {
      session = await readDesktopSession(root, descriptor);
      await requestDesktopSession(session, { operation: "status", timeoutMs: 1000 });
    } catch {
      continue; // Exclusive activity below also catches clients without descriptors.
    }
    assert(
      session.mode === undefined && session.version === current.activeVersion,
      "Another Desktop version or validation session is active",
    );
    live.push(descriptor);
  }
  assert(live.length <= 1, "Multiple Desktop sessions require attention");
  return createDesktopUpdateTransport({
    installationRoot: root,
    descriptor: live[0],
    readyTimeoutMs,
    allowIdle: true,
  });
}

/** Isolated candidate transport. launchCandidate must independently verify the
 * selected executable/pointer and avoid duplicate launch after an uncertain exit.
 * The session ID binds readiness; it is never publisher or privileged authority. */
export function createValidationDesktopTransport(
  { installationRoot, version, validationId, timeoutMs = 30000 },
  { authorize, launchCandidate },
) {
  const root = path.resolve(installationRoot);
  assert(/^[a-f0-9]{64}$/u.test(validationId));
  assert(typeof version === "string" && version.length <= 80);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  assert(typeof authorize === "function" && typeof launchCandidate === "function");
  const identity = Object.freeze({ root, version, validationId });
  const matching = async () => {
    const found = [];
    for (const file of await sessionFiles(root)) {
      try {
        const session = await readDesktopSession(root, file);
        if (
          session.version !== version ||
          session.mode !== "update-validation" ||
          session.validationId !== validationId
        )
          continue;
        const response = await requestDesktopSession(session, {
          operation: "status",
          timeoutMs: 1000,
        });
        found.push({ session, response });
      } catch {
        /* A stale descriptor cannot acknowledge readiness. */
      }
    }
    assert(found.length <= 1, "Multiple validation Desktops require recovery");
    return found[0];
  };
  return {
    startValidationDesktop: async () => {
      assert.equal(await authorize(identity), true, "Candidate launch authorization refused");
      let live = await matching();
      if (!live)
        await launchCandidate(
          Object.freeze({
            ...identity,
            arguments: [`--honeybee-update-validation=${validationId}`],
          }),
        );
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        live = await matching();
        if (live?.response.status === "ready")
          return {
            ready: true,
            mode: "update-validation",
            validationId,
            version,
            sessionId: live.session.sessionId,
          };
        await delay(100);
      }
      throw new Error("Validation Desktop readiness timed out");
    },
    stopValidationDesktop: async () => {
      const live = await matching();
      if (!live) return;
      const result = await requestDesktopSession(live.session, {
        operation: "shutdown",
        timeoutMs,
      });
      assert.equal(result.status, "accepted", "Validation Desktop refused shutdown");
      // Acknowledgment precedes process exit; caller must also acquire exclusive
      // activity before restoring files or admitting normal application writes.
    },
  };
}

/** Concrete transport composition; release/Doctor/restart authorization stays explicit. */
export const updateAndRestartDesktopWithDoctor = async (options, hooks = {}) => {
  if (options.setupActivation === true) {
    const transport = await createSetupDesktopUpdateTransport(options);
    return updateAndRestartWithDoctor(options, { ...hooks, ...transport });
  }
  const session = await readDesktopSession(options.installationRoot, options.desktopDescriptor);
  const current = JSON.parse(
    await readBounded(path.join(options.installationRoot, "current.json")),
  );
  assert.equal(session.version, current.activeVersion, "Desktop is not the active source version");
  const transport = await createDesktopUpdateTransport({
    installationRoot: options.installationRoot,
    descriptor: options.desktopDescriptor,
    readyTimeoutMs: options.readyTimeoutMs,
  });
  return updateAndRestartWithDoctor(options, { ...hooks, ...transport });
};
