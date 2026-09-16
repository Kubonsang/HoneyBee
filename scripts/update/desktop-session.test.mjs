import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openDesktopUpdateSession } from "../../apps/desktop/dist/main/main/update-session.js";
import { DesktopUpdateShutdown } from "../../apps/desktop/dist/main/main/update-shutdown.js";
import { DesktopActivityDrain } from "../../apps/desktop/dist/main/main/activity-drain.js";
import {
  readDesktopSession,
  requestDesktopSession,
  createDesktopUpdateTransport,
  createValidationDesktopTransport,
  createSetupDesktopUpdateTransport,
} from "./desktop-session.mjs";

test("Setup supports idle admission and preserves Desktop cancellation", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "current.json"), JSON.stringify({ activeVersion: "test.1" }));
  const transport = await createSetupDesktopUpdateTransport({ installationRoot: f.root });
  const response = await transport.requestShutdown({
    root: f.root,
    requestId: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(response.status, "cancelled");
  assert.equal(f.quits(), 0);
  const idleRoot = await mkdtemp(path.join(path.dirname(f.root), "idle-"));
  await writeFile(path.join(idleRoot, "current.json"), JSON.stringify({ activeVersion: "test.1" }));
  const idle = await createSetupDesktopUpdateTransport({ installationRoot: idleRoot });
  assert.deepEqual(await idle.requestShutdown({ root: idleRoot, requestId: "idle-request" }), {
    requestId: "idle-request",
    status: "accepted",
  });
});

test("Setup refuses a live foreign version before shutdown", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "current.json"), JSON.stringify({ activeVersion: "other" }));
  await assert.rejects(
    createSetupDesktopUpdateTransport({ installationRoot: f.root }),
    /Another Desktop/,
  );
  assert.equal(f.quits(), 0);
});

test("validation sessions are transaction-bound and cannot satisfy normal restart", async (t) => {
  const id = "a".repeat(64);
  const f = await fixture(t);
  const ordinary = await createDesktopUpdateTransport({
    installationRoot: f.root,
    descriptor: f.session.descriptor,
    readyTimeoutMs: 100,
  });
  await ordinary.prepareRestart();
  const candidate = await openDesktopUpdateSession({
    root: f.root,
    version: "test.2",
    validationId: id,
    isReady: () => true,
    shutdown: async () => "accepted",
    quit: () => {},
  });
  t.after(() => candidate.close());
  const transport = createValidationDesktopTransport(
    { installationRoot: f.root, version: "test.2", validationId: id, timeoutMs: 100 },
    {
      authorize: async () => true,
      launchCandidate: () => assert.fail("Existing candidate must be reused"),
    },
  );
  const ready = await transport.startValidationDesktop();
  assert.equal(ready.validationId, id);
  assert.equal(ready.sessionId, (await readDesktopSession(f.root, candidate.descriptor)).sessionId);
  await assert.rejects(ordinary.waitForReady({ version: "test.2" }), /did not report/);
  const denied = createValidationDesktopTransport(
    { installationRoot: f.root, version: "test.2", validationId: id, timeoutMs: 100 },
    { authorize: async () => false, launchCandidate: () => assert.fail("unauthorized launch") },
  );
  await assert.rejects(denied.startValidationDesktop(), /authorization refused/);
  await transport.stopValidationDesktop();
});

const fixture = async (t, overrides = {}) => {
  const base = path.resolve("output/desktop-session-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  let quits = 0;
  const session = await openDesktopUpdateSession({
    root,
    version: "test.1",
    isReady: () => true,
    shutdown: async () => "cancelled",
    quit: () => {
      quits++;
    },
    ...overrides,
  });
  t.after(() => session.close());
  return {
    root,
    session,
    identity: await readDesktopSession(root, session.descriptor),
    quits: () => quits,
  };
};
test("authenticated status and cancelled shutdown preserve the running session", async (t) => {
  const f = await fixture(t);
  assert.equal((await requestDesktopSession(f.identity, { operation: "status" })).status, "ready");
  assert.equal(
    (await requestDesktopSession(f.identity, { operation: "shutdown" })).status,
    "cancelled",
  );
  assert.equal(f.quits(), 0);
  assert.equal((await requestDesktopSession(f.identity, { operation: "status" })).status, "ready");
});
test("bad token, wrong installation and wrong session never reach shutdown", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    shutdown: async () => {
      calls++;
      return "accepted";
    },
  });
  for (const mutation of [{ token: "0".repeat(64) }, { root: "wrong" }, { sessionId: "wrong" }])
    await assert.rejects(
      requestDesktopSession({ ...f.identity, ...mutation }, { operation: "shutdown" }),
    );
  assert.equal(calls, 0);
  assert.equal(f.quits(), 0);
});
test("accepted reply is observable before quit is dispatched", async (t) => {
  const f = await fixture(t, { shutdown: async () => "accepted" });
  assert.equal(
    (await requestDesktopSession(f.identity, { operation: "shutdown" })).status,
    "accepted",
  );
  await delay(20);
  assert.equal(f.quits(), 1);
  assert.equal(
    (await requestDesktopSession(f.identity, { operation: "shutdown" })).status,
    "unavailable",
  );
});
test("disconnect cancels a pending shutdown and reopens work admission", async (t) => {
  let shutdown;
  const drain = new DesktopActivityDrain(() => shutdown.drained());
  shutdown = new DesktopUpdateShutdown(drain, () => assert.fail("must not prompt before drain"));
  let finish;
  const work = drain.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = await fixture(t, { shutdown: (signal) => shutdown.request(signal) });
  const abort = new globalThis.AbortController();
  const response = requestDesktopSession(f.identity, {
    operation: "shutdown",
    signal: abort.signal,
  });
  const rejected = assert.rejects(response, /cancelled/u);
  for (let i = 0; i < 100 && !shutdown.pending; i++) await delay(10);
  assert(shutdown.pending);
  abort.abort();
  await rejected;
  for (let i = 0; i < 100 && shutdown.pending; i++) await delay(10);
  assert.equal(shutdown.pending, false);
  assert.equal(drain.isClosing, false);
  finish();
  await work;
  assert.equal(await drain.run(() => "allowed"), "allowed");
  assert.equal(f.quits(), 0);
});
test("pending work completes before consent and declined consent reopens admission", async () => {
  let prompts = 0;
  let shutdown;
  const drain = new DesktopActivityDrain(() => shutdown.drained());
  shutdown = new DesktopUpdateShutdown(drain, () => {
    prompts++;
    return false;
  });
  let finish;
  const work = drain.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const response = shutdown.request(new globalThis.AbortController().signal);
  assert.equal(prompts, 0);
  await assert.rejects(
    drain.run(() => {}),
    /closing/u,
  );
  finish();
  await work;
  assert.equal(await response, "cancelled");
  assert.equal(prompts, 1);
  assert.equal(drain.isClosing, false);
});
test("readiness requires a new session with the selected version", async (t) => {
  const f = await fixture(t);
  const transport = await createDesktopUpdateTransport({
    installationRoot: f.root,
    descriptor: f.session.descriptor,
    readyTimeoutMs: 150,
  });
  await transport.prepareRestart();
  await assert.rejects(transport.waitForReady({ version: "test.1" }), /did not report/u);
  let ready = false;
  const next = await openDesktopUpdateSession({
    root: f.root,
    version: "test.2",
    isReady: () => ready,
    shutdown: async () => "cancelled",
    quit: () => {},
  });
  t.after(() => next.close());
  await assert.rejects(transport.waitForReady({ version: "test.2" }), /did not report/u);
  ready = true;
  const result = await transport.waitForReady({ version: "test.2" });
  assert.equal(result.version, "test.2");
  assert.equal(result.readiness, "renderer-loaded");
  assert.notEqual(result.sessionId, f.identity.sessionId);
});
