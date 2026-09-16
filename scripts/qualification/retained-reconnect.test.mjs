import assert from "node:assert/strict";
import test from "node:test";
import { reconnectRetained } from "./retained-reconnect.mjs";
const fixture = () => {
  const before = { schemaVersion: 1, files: "dirty edits", registry: "unchanged" };
  const workspace = {
    leaseId: "lease",
    consumerId: "consumer",
    storageWorkspaceId: "workspace",
    mountPath: "mount",
  };
  const journal = {
    leaseId: "lease",
    runId: "consumer",
    workspaceId: "workspace",
    mountPath: "mount",
    state: "ready",
    retained: true,
  };
  const calls = [],
    records = [];
  return {
    before,
    workspace,
    journal,
    calls,
    records,
    snapshot: async () => before,
    control: async (r) => {
      calls.push(r.operation);
      return r.operation === "heartbeat"
        ? { ok: false, error: { code: "lease-not-active" } }
        : { ok: true, lease: { leaseId: "lease", mountPath: "mount" } };
    },
    record: async (name, value) => records.push({ name, value }),
    doctor: async () => ({ ready: true, summary: { fail: 0 } }),
  };
};
test("inactive retained lease reconnects without registry rewrite and preserves original comparison", async () => {
  const f = fixture();
  assert.equal((await reconnectRetained(f)).restored, true);
  assert.deepEqual(f.calls, ["heartbeat", "attach-retained"]);
  assert.deepEqual(
    f.records.map((r) => r.name),
    ["heartbeat", "attach-intent", "attach-result", "doctor"],
  );
});
test("changed data or wrong retained identity prevent any control action", async () => {
  for (const kind of ["data", "identity", "retained"]) {
    const f = fixture();
    if (kind === "data") f.snapshot = async () => ({ schemaVersion: 1, files: "changed" });
    if (kind === "identity") f.journal.runId = "other";
    if (kind === "retained") f.journal.retained = false;
    await assert.rejects(reconnectRetained(f));
    assert.deepEqual(f.calls, []);
  }
});
test("active lease is validated without attaching; unrelated errors fail closed", async () => {
  const f = fixture();
  f.control = async (r) => {
    f.calls.push(r.operation);
    return { ok: true, lease: { leaseId: "lease", mountPath: "mount" } };
  };
  assert.equal((await reconnectRetained(f)).attached, false);
  assert.deepEqual(f.calls, ["heartbeat"]);
  f.control = async () => ({ ok: false, error: { code: "lease-not-found" } });
  await assert.rejects(reconnectRetained(f), /inactive retained/);
});
test("intent write failure prevents attachment and wrong returned lease prevents success", async () => {
  const f = fixture();
  f.record = async (name) => {
    if (name === "attach-intent") throw Error("disk full");
  };
  await assert.rejects(reconnectRetained(f), /disk full/);
  assert.deepEqual(f.calls, ["heartbeat"]);
  const g = fixture();
  g.control = async () => ({ ok: true, lease: { leaseId: "other", mountPath: "mount" } });
  await assert.rejects(reconnectRetained(g));
});
