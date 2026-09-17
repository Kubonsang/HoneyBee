import assert from "node:assert/strict";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import {
  readInstalledStorage,
  WorkspaceRegistryStore,
  WorkspaceToolResolver,
  WindowsWorkspaceStorage,
  requireCompatibleStorage,
} from "../../packages/core/dist/index.js";
import { readBounded } from "../update/prepare-release.mjs";

const key = (value) => path.resolve(value).toLowerCase();
const same = (a, b) => key(a) === key(b);
const identifier = (value) => {
  assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value));
  return value;
};
const record = async (file) => {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), "Redirected recovery record");
  return JSON.parse(await readBounded(file));
};

// The broker remains responsible for native image/file identity validation.
// These checks bind its existing retained operation to this registry entry;
// recovery must never reconstruct worktrees, junctions, or registry records.
export const assertRetainedIdentity = (workspace, lease, retained, owner) => {
  assert.equal(workspace.state, "ready");
  assert.equal(workspace.layout, "git-worktree-library-cow-v1");
  assert.equal(lease.schemaVersion, 2);
  assert.equal(lease.state, "ready");
  assert.equal(lease.retained, true);
  assert.equal(retained.schemaVersion, 2);
  assert.equal(owner.schemaVersion, 1);
  assert.equal(owner.provider, "vhdx-differencing");
  assert.equal(lease.leaseId, workspace.leaseId);
  assert.equal(lease.runId, workspace.consumerId);
  assert.equal(lease.workspaceId, workspace.storageWorkspaceId);
  assert.equal(lease.parentKey, workspace.parentId);
  assert(same(lease.mountPath, workspace.mountPath));
  assert(same(lease.workspacePath, workspace.storageWorkspacePath));
  assert(typeof lease.ownershipToken === "string" && lease.ownershipToken.length > 0);
  for (const value of [retained, owner]) {
    assert.equal(value.leaseId, lease.leaseId);
    assert.equal(value.runId, lease.runId);
    assert.equal(value.ownershipToken, lease.ownershipToken);
  }
  assert.equal(retained.parentKey, lease.parentKey);
  assert(same(retained.childPath, lease.childPath));
  assert.equal(owner.workspaceId, lease.workspaceId);
  assert(same(owner.workspacePath, lease.workspacePath));
  assert(same(owner.mountPath, lease.mountPath));
};

export const reconnectLease = async (workspace, { heartbeat, attach, record: log, assertHeld }) => {
  assertHeld();
  let lease = await heartbeat(workspace.leaseId);
  assertHeld();
  const attached = lease === undefined;
  if (attached) {
    await log("attach-intent", { workspaceId: workspace.workspaceId, leaseId: workspace.leaseId });
    assertHeld();
    lease = await attach(workspace.consumerId, workspace.storageWorkspaceId);
    assertHeld();
  }
  assert.equal(lease.leaseId, workspace.leaseId);
  assert(same(lease.mountPath, workspace.mountPath));
  assert(same(lease.workspacePath, workspace.storageWorkspacePath));
  await log("lease-ready", {
    workspaceId: workspace.workspaceId,
    leaseId: lease.leaseId,
    attached,
  });
};

/** Called only under exclusive application activity after authenticated source verification. */
export const reconnectRecoveryWorkspaces = async ({ root, version, assertHeld, record: log }) => {
  assertHeld();
  const storage = new WindowsWorkspaceStorage();
  const options = await readInstalledStorage(path.join(root, "versions", version));
  assert(
    options?.managed && same(options.installationRoot, root),
    "Managed recovery tools required",
  );
  const tools = new WorkspaceToolResolver(options).resolve();
  await requireCompatibleStorage(storage, tools);
  const service = await storage.serviceEvidence(tools);
  const registry = new WorkspaceRegistryStore(path.join(root, "workspace-core"));
  const before = await registry.read();
  const prepared = [];
  for (const workspace of before.workspaces) {
    const project = before.projects.find((item) => item.projectId === workspace.projectId);
    assert(project?.storageBinding?.kind === "managed-v1", "Recovery requires adopted workspace");
    assert(same(project.storageBinding.installationRoot, root), "Different workspace installation");
    const relative = path.join(project.unityRelativePath, "Library");
    const library = path.resolve(workspace.workspacePath, relative);
    const within = path.relative(workspace.workspacePath, library);
    assert(
      within && !within.startsWith("..") && !path.isAbsolute(within),
      "Library escaped worktree",
    );
    assert((await lstat(library)).isSymbolicLink(), "Existing Library junction required");
    assert(
      same(path.resolve(path.dirname(library), await readlink(library)), workspace.mountPath),
      "Library target differs",
    );
    const userRoot = path.join(service.receipt.storeRoot, identifier(service.receipt.userSid));
    const lease = await record(
      path.join(userRoot, "leases", identifier(workspace.leaseId) + ".json"),
    );
    const retained = await record(
      path.join(userRoot, "retained", identifier(workspace.consumerId) + ".json"),
    );
    const owner = await record(
      path.join(workspace.storageWorkspacePath, ".testplay-vhdx-workspace-owner.json"),
    );
    assertRetainedIdentity(workspace, lease, retained, owner);
    assert.equal(lease.userSid, service.receipt.userSid);
    assert(same(lease.childPath, path.join(userRoot, "children", workspace.leaseId + ".vhdx")));
    assert(
      same(
        workspace.storageWorkspacePath,
        path.join(service.receipt.workspaceRoot, identifier(workspace.storageWorkspaceId)),
      ),
    );
    assert(same(workspace.mountPath, path.join(workspace.storageWorkspacePath, "Library")));
    prepared.push(workspace);
  }
  // Admit the whole set before the first attach. Preserve intentional non-ready
  // states by refusing them, rather than treating every Doctor failure as repairable.
  assert.deepEqual(await registry.read(), before, "Registry changed during recovery admission");
  for (const workspace of prepared) {
    await reconnectLease(workspace, {
      assertHeld,
      record: log,
      heartbeat: (id) => storage.heartbeat(tools, id, { inactiveOnly: true }),
      attach: (run, id) => storage.attachRetained(tools, run, id),
    });
    await realpath(workspace.mountPath);
  }
  assert.deepEqual(await registry.read(), before, "Registry changed during reconnect");
  assertHeld();
};
