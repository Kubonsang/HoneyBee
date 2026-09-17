import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { assertRetainedIdentity, reconnectLease } from "./reconnect-workspaces.mjs";

const fixture = () => {
  const workspace = {
    state: "ready",
    layout: "git-worktree-library-cow-v1",
    workspaceId: "registry-id",
    leaseId: "lease",
    consumerId: "consumer",
    storageWorkspaceId: "child",
    parentId: "parent",
    mountPath: path.resolve("fixture/child/Library"),
    storageWorkspacePath: path.resolve("fixture/child"),
  };
  const lease = {
    schemaVersion: 2,
    state: "ready",
    retained: true,
    leaseId: "lease",
    runId: "consumer",
    workspaceId: "child",
    parentKey: "parent",
    mountPath: workspace.mountPath,
    workspacePath: workspace.storageWorkspacePath,
    childPath: path.resolve("fixture/child.vhdx"),
    ownershipToken: "owner",
  };
  const retained = { ...lease };
  const owner = { ...lease, schemaVersion: 1, provider: "vhdx-differencing" };
  const calls = [];
  return {
    workspace,
    lease,
    retained,
    owner,
    calls,
    operations: {
      assertHeld: () => {},
      heartbeat: async () => {
        calls.push("heartbeat");
        return undefined;
      },
      attach: async () => {
        calls.push("attach");
        return lease;
      },
      record: async (event) => {
        calls.push(event);
      },
    },
  };
};
test("retained identity admission requires independent matching records", () => {
  const f = fixture();
  assertRetainedIdentity(f.workspace, f.lease, f.retained, f.owner);
  for (const [record, field, value] of [
    ["lease", "retained", false],
    ["lease", "state", "released"],
    ["workspace", "state", "cleanup-pending"],
    ["retained", "ownershipToken", "other"],
    ["owner", "workspaceId", "other"],
    ["owner", "mountPath", path.resolve("other")],
    ["lease", "parentKey", "other"],
    ["retained", "childPath", path.resolve("other")],
    ["owner", "schemaVersion", 9],
  ]) {
    const g = fixture();
    g[record][field] = value;
    assert.throws(() => assertRetainedIdentity(g.workspace, g.lease, g.retained, g.owner));
  }
});
test("inactive lease reconnect records intent before attachment", async () => {
  const f = fixture();
  await reconnectLease(f.workspace, f.operations);
  assert.deepEqual(f.calls, ["heartbeat", "attach-intent", "attach", "lease-ready"]);
});
test("active lease requires no attach", async () => {
  const f = fixture();
  f.operations.heartbeat = async () => f.lease;
  await reconnectLease(f.workspace, f.operations);
  assert.deepEqual(f.calls, ["lease-ready"]);
});
test("heartbeat failure does not authorize attach", async () => {
  for (const code of ["lease-not-found", "lease-not-ready", "access-denied"]) {
    const f = fixture();
    f.operations.heartbeat = async () => {
      throw Error(code);
    };
    await assert.rejects(reconnectLease(f.workspace, f.operations), new RegExp(code));
    assert.deepEqual(f.calls, []);
  }
});
test("failed evidence write prevents reconnect", async () => {
  const f = fixture();
  f.operations.record = async () => {
    throw Error("disk full");
  };
  await assert.rejects(reconnectLease(f.workspace, f.operations), /disk full/);
  assert.deepEqual(f.calls, ["heartbeat"]);
});
test("lost activity ownership prevents attach", async () => {
  const f = fixture();
  let held = true;
  f.operations.assertHeld = () => assert(held);
  f.operations.record = async () => {
    held = false;
  };
  await assert.rejects(reconnectLease(f.workspace, f.operations));
  assert.deepEqual(f.calls, ["heartbeat"]);
});
test("wrong returned lease or mount cannot be reported as ready", async () => {
  for (const change of [
    { leaseId: "other" },
    { mountPath: path.resolve("other") },
    { workspacePath: path.resolve("other") },
  ]) {
    const f = fixture();
    f.operations.attach = async () => ({ ...f.lease, ...change });
    await assert.rejects(reconnectLease(f.workspace, f.operations));
    assert(!f.calls.includes("lease-ready"));
  }
});
