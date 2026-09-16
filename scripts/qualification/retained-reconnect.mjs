import assert from "node:assert/strict";
import { assertPreserved } from "./preservation.mjs";

// Reuse the same attach-retained primitive as Workspace Repair, without
// rewriting the registry timestamps or replacing the recorded preservation baseline.
export async function reconnectRetained({
  before,
  workspace,
  journal,
  snapshot,
  control,
  record,
  doctor,
}) {
  assert.equal(journal.leaseId, workspace.leaseId);
  assert.equal(journal.runId, workspace.consumerId);
  assert.equal(journal.workspaceId, workspace.storageWorkspaceId);
  assert.equal(journal.mountPath, workspace.mountPath);
  assert.equal(journal.state, "ready");
  assert.equal(journal.retained, true);
  assertPreserved(before, await snapshot());
  const heartbeat = await control({ operation: "heartbeat", leaseId: workspace.leaseId });
  await record("heartbeat", heartbeat);
  let response = heartbeat;
  if (!heartbeat.ok) {
    assert.equal(
      heartbeat.error?.code,
      "lease-not-active",
      "Only an inactive retained lease may reconnect",
    );
    await record("attach-intent", {
      leaseId: workspace.leaseId,
      consumerId: workspace.consumerId,
      storageWorkspaceId: workspace.storageWorkspaceId,
    });
    response = await control({
      operation: "attach-retained",
      runId: workspace.consumerId,
      workspaceId: workspace.storageWorkspaceId,
    });
    await record("attach-result", response);
  }
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.lease.leaseId, workspace.leaseId);
  assert.equal(response.lease.mountPath, workspace.mountPath);
  assertPreserved(before, await snapshot());
  const health = await doctor();
  await record("doctor", health);
  assert.equal(health.ready, true);
  assert.equal(health.summary.fail, 0);
  return { restored: true, registryAndGitPreserved: true, attached: !heartbeat.ok };
}
