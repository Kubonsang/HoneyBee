import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { packageTool } from "./prepare-release.mjs";
import { withApplicationActivity } from "./application-activity.mjs";
const fixture = async () => {
  const base = path.resolve("output/activity-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  await mkdir(path.join(root, "update"));
  return root;
};
const owner = (t, root, mode, timeout = 3000) => {
  const child = spawn(packageTool, ["activity", path.join(root, "update"), mode, String(timeout)], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  child.stdin.on("error", () => {});
  const exit = once(child, "exit");
  t.after(() => child.kill());
  return { child, exit, output: () => stdout, error: () => stderr };
};
const waitFor = async (owner, text) => {
  for (let i = 0; i < 100; i++) {
    if (owner.output().includes(text)) return;
    if (owner.child.exitCode !== null) assert.fail(owner.error());
    await setTimeout(20);
  }
  assert.fail("Activity checkpoint timeout");
};

test("parent pipe closure cancels a pending drain without killing the client", async (t) => {
  const root = await fixture(),
    client = owner(t, root, "shared");
  await waitFor(client, "HELD");
  const update = owner(t, root, "exclusive");
  await waitFor(update, "DRAINING");
  update.child.stdin.end();
  assert.notEqual((await update.exit)[0], 0);
  assert.equal(client.child.exitCode, null);
  await withApplicationActivity({ installationRoot: root, mode: "shared" }, async () => {});
  client.child.stdin.end();
  await client.exit;
});

test("redirected activity directory refuses acquisition", async () => {
  const root = await fixture(),
    other = await fixture();
  await symlink(path.join(other, "update"), path.join(root, "redirect"), "junction");
  await assert.rejects(
    withApplicationActivity(
      { installationRoot: path.join(root, "redirect"), mode: "shared" },
      async () => assert.fail("must not acquire"),
    ),
  );
});
test("concurrent clients drain before updater; new clients refuse while draining", async (t) => {
  const root = await fixture(),
    a = owner(t, root, "shared"),
    b = owner(t, root, "shared");
  await waitFor(a, "HELD");
  await waitFor(b, "HELD");
  const update = owner(t, root, "exclusive");
  await waitFor(update, "DRAINING");
  assert(!update.output().includes("HELD"));
  const rejected = owner(t, root, "shared");
  assert.notEqual((await rejected.exit)[0], 0);
  a.child.stdin.end();
  await a.exit;
  assert(!update.output().includes("HELD"));
  b.child.stdin.end();
  await b.exit;
  await waitFor(update, "HELD");
  const competing = owner(t, root, "exclusive");
  assert.notEqual((await competing.exit)[0], 0);
  update.child.stdin.end();
  await update.exit;
  await withApplicationActivity(
    { installationRoot: root, mode: "shared" },
    async ({ assertHeld }) => assertHeld(),
  );
});
test("drain timeout releases admission without terminating an active client", async (t) => {
  const root = await fixture(),
    client = owner(t, root, "shared");
  await waitFor(client, "HELD");
  const update = owner(t, root, "exclusive", 100);
  assert.notEqual((await update.exit)[0], 0);
  assert.equal(client.child.exitCode, null);
  await withApplicationActivity({ installationRoot: root, mode: "shared" }, async () => {});
  client.child.stdin.end();
  await client.exit;
});
test("killing a client releases activity for a waiting updater", async (t) => {
  const root = await fixture(),
    client = owner(t, root, "shared");
  await waitFor(client, "HELD");
  const update = owner(t, root, "exclusive");
  await waitFor(update, "DRAINING");
  client.child.kill();
  await client.exit;
  await waitFor(update, "HELD");
  update.child.stdin.end();
  await update.exit;
});
for (const acquired of [false, true])
  test(`updater death releases gate while ${acquired ? "held" : "draining"}`, async (t) => {
    const root = await fixture();
    let client;
    if (!acquired) {
      client = owner(t, root, "shared");
      await waitFor(client, "HELD");
    }
    const update = owner(t, root, "exclusive");
    await waitFor(update, acquired ? "HELD" : "DRAINING");
    update.child.kill();
    await update.exit;
    await withApplicationActivity({ installationRoot: root, mode: "shared" }, async () => {});
    if (client) {
      client.child.stdin.end();
      await client.exit;
    }
  });
test("callback failure releases exclusive activity and independent roots do not block", async () => {
  const root = await fixture(),
    other = await fixture();
  await assert.rejects(
    withApplicationActivity({ installationRoot: root, mode: "exclusive" }, async () => {
      await withApplicationActivity({ installationRoot: other, mode: "shared" }, async () => {});
      throw new Error("injected");
    }),
    /injected/u,
  );
  await withApplicationActivity({ installationRoot: root, mode: "shared" }, async () => {});
});

test("validation shares activity then drains before mutation", async (t) => {
  const root = await fixture();
  await withApplicationActivity({ installationRoot: root, mode: "exclusive" }, async (lease) => {
    const blocked = owner(t, root, "shared", 100);
    assert.notEqual((await blocked.exit)[0], 0);
    await lease.setMode("shared");
    assert.throws(lease.assertExclusive);
    const candidate = owner(t, root, "shared");
    await waitFor(candidate, "HELD");
    let acquired = false;
    const drain = lease.setMode("exclusive").then(() => {
      acquired = true;
    });
    await setTimeout(75);
    assert.equal(acquired, false);
    candidate.child.stdin.end();
    await candidate.exit;
    await drain;
    lease.assertExclusive();
  });
});

test("failed validation drain cannot authorize mutation", async (t) => {
  const root = await fixture();
  const candidate = owner(t, root, "shared");
  await waitFor(candidate, "HELD");
  let mutation = false;
  await assert.rejects(
    withApplicationActivity(
      { installationRoot: root, mode: "shared", timeoutMs: 100 },
      async (lease) => {
        await lease.setMode("exclusive");
        lease.assertExclusive();
        mutation = true;
      },
    ),
  );
  assert.equal(mutation, false);
  assert.equal(candidate.child.exitCode, null);
  candidate.child.stdin.end();
  await candidate.exit;
  await withApplicationActivity({ installationRoot: root, mode: "exclusive" }, async (lease) =>
    lease.assertExclusive(),
  );
});
