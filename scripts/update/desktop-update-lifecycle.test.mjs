import { windowsTest } from "../test-support/windows-test.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { withApplicationActivity } from "./application-activity.mjs";
import { withDesktopUpdateLifecycle } from "./desktop-update-lifecycle.mjs";

const fixture = async () => {
  const base = path.resolve("output/desktop-update-lifecycle-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const pointer = path.join(root, "current.json");
  await writeFile(pointer, "source");
  await writeFile(path.join(root, "HoneyBeeLauncher.exe"), "pinned test launcher");
  const options = {
    installationRoot: root,
    sourcePointerSha256: sha256("source"),
    launcherSha256: sha256("pinned test launcher"),
    shutdownTimeoutMs: 1000,
    drainTimeoutMs: 100,
  };
  let dispatched = 0;
  const hooks = {
    requestShutdown: async ({ requestId }) => ({ requestId, status: "accepted" }),
    authorizeRestart: async () => true,
    dispatchLauncher: async ({ executable }) => {
      assert.equal(executable, path.join(root, "HoneyBeeLauncher.exe"));
      // Restart must run after exclusive ownership has ended.
      await withApplicationActivity({ installationRoot: root, mode: "shared" }, async () => {});
      dispatched++;
    },
  };
  const activate = async ({ assertHeld }) => {
    assertHeld();
    await writeFile(pointer, "target");
    return { state: "Committed", transactionDirectory: "test-journal" };
  };
  return { root, pointer, options, hooks, activate, dispatched: () => dispatched };
};

test("cancelled shutdown neither activates nor restarts", async () => {
  const f = await fixture();
  f.hooks.requestShutdown = async ({ requestId }) => ({ requestId, status: "cancelled" });
  assert.equal(
    (await withDesktopUpdateLifecycle(f.options, f.hooks, f.activate)).state,
    "Cancelled",
  );
  assert.equal(await readFile(f.pointer, "utf8"), "source");
  assert.equal(f.dispatched(), 0);
});
windowsTest("accepted response cannot bypass a live application's shared lease", async () => {
  const f = await fixture();
  await withApplicationActivity({ installationRoot: f.root, mode: "shared" }, async () => {
    await assert.rejects(
      withDesktopUpdateLifecycle(f.options, f.hooks, f.activate),
      /drain timed out/u,
    );
  });
  assert.equal(await readFile(f.pointer, "utf8"), "source");
  assert.equal(f.dispatched(), 0);
});
windowsTest("committed update releases admission before stable-launcher dispatch", async () => {
  const f = await fixture();
  const result = await withDesktopUpdateLifecycle(f.options, f.hooks, f.activate);
  assert.equal(result.state, "Committed");
  assert.equal(result.restart, "Dispatched");
  assert.equal(f.dispatched(), 1);
});
windowsTest("validated rollback restarts the source", async () => {
  const f = await fixture();
  const result = await withDesktopUpdateLifecycle(f.options, f.hooks, async () => ({
    state: "RolledBack",
  }));
  assert.equal(result.state, "RolledBack");
  assert.equal(result.restart, "Dispatched");
  assert.equal(await readFile(f.pointer, "utf8"), "source");
});
windowsTest("recovery-required failure does not restart", async () => {
  const f = await fixture();
  await assert.rejects(
    withDesktopUpdateLifecycle(f.options, f.hooks, async () => {
      throw new Error("Recovery required");
    }),
    /Recovery required/u,
  );
  assert.equal(f.dispatched(), 0);
});
windowsTest("dispatch failure preserves committed result and pointer", async () => {
  const f = await fixture();
  f.hooks.dispatchLauncher = async () => {
    throw new Error("Launch failed");
  };
  const result = await withDesktopUpdateLifecycle(f.options, f.hooks, f.activate);
  assert.equal(result.state, "Committed");
  assert.equal(result.restart, "Failed");
  assert.equal(await readFile(f.pointer, "utf8"), "target");
});
windowsTest("restart authorization failure retains terminal activation state", async () => {
  const f = await fixture();
  f.hooks.authorizeRestart = async () => false;
  const result = await withDesktopUpdateLifecycle(f.options, f.hooks, f.activate);
  assert.equal(result.state, "Committed");
  assert.equal(result.restart, "Failed");
  assert.equal(f.dispatched(), 0);
});
test("wrong response identity and shutdown timeout leave the source untouched", async () => {
  const f = await fixture();
  f.hooks.requestShutdown = async () => ({ requestId: "wrong", status: "accepted" });
  await assert.rejects(withDesktopUpdateLifecycle(f.options, f.hooks, f.activate), /Unrelated/u);
  f.options.shutdownTimeoutMs = 20;
  let signal;
  f.hooks.requestShutdown = (context) => {
    signal = context.signal;
    return new Promise(() => {});
  };
  await assert.rejects(withDesktopUpdateLifecycle(f.options, f.hooks, f.activate), /timed out/u);
  assert(signal.aborted);
  assert.equal(await readFile(f.pointer, "utf8"), "source");
});
windowsTest("launcher tampering or a new pointer after activation prevents dispatch", async () => {
  for (const file of ["HoneyBeeLauncher.exe", "current.json"]) {
    const f = await fixture();
    f.hooks.authorizeRestart = async () => {
      await writeFile(path.join(f.root, file), "changed");
      return true;
    };
    const result = await withDesktopUpdateLifecycle(f.options, f.hooks, f.activate);
    assert.equal(result.state, "Committed");
    assert.equal(result.restart, "Failed");
    assert.equal(f.dispatched(), 0);
  }
});

for (const ready of [true, false])
  windowsTest(
    `readiness ${ready ? "acknowledges selected version" : "failure retains commit"}`,
    async () => {
      const f = await fixture();
      let prepared = false;
      f.hooks.prepareRestart = async () => {
        prepared = true;
      };
      f.hooks.waitForReady = async ({ version }) => {
        assert(prepared);
        assert.equal(f.dispatched(), 1);
        assert.equal(version, "test.2");
        if (!ready) throw new Error("Desktop readiness timed out");
        return { version, readiness: "renderer-loaded", sessionId: "new-session" };
      };
      const result = await withDesktopUpdateLifecycle(f.options, f.hooks, async () => {
        await writeFile(f.pointer, JSON.stringify({ activeVersion: "test.2" }));
        return { state: "Committed" };
      });
      assert.equal(result.state, "Committed");
      assert.equal(result.restart, ready ? "Ready" : "Failed");
      assert.equal(JSON.parse(await readFile(f.pointer)).activeVersion, "test.2");
    },
  );
