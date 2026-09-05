import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const digest = (data) => createHash("sha256").update(data).digest("hex");

// Unity writes forwarded credentials into its command-line log header.
export function redactUnityLog(text) {
  const lines = text.split(/\r?\n/);
  let nextIsSecret = false;
  return lines
    .map((line) => {
      if (nextIsSecret) {
        nextIsSecret = false;
        return "[redacted]";
      }
      if (/^-(?:accessToken|refreshToken|password)$/i.test(line.trim())) nextIsSecret = true;
      return line.replace(/(-(?:accessToken|refreshToken|password)[=\t ]+).*/i, "$1[redacted]");
    })
    .join("\n");
}

export function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assert(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative),
    `Path is outside the dedicated run root: ${target}`,
  );
  return target;
}

export function disjoint(left, right) {
  for (const [root, target] of [
    [left, right],
    [right, left],
  ]) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    assert(
      relative &&
        (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
      "The run directory and original source must not overlap",
    );
  }
}

export async function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      assert(
        !(await lstat(current)).isSymbolicLink(),
        `Reparse/symlink path is not allowed: ${current}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function healthy(status) {
  for (const key of ["activeChildCount", "retainedChildCount", "pendingCount", "quarantineCount"]) {
    assert(Number.isSafeInteger(status[key]) && status[key] >= 0, `Invalid status: ${key}`);
  }
  assert.equal(
    status.activeChildCount,
    0,
    "Close active storage clients before shared-host validation",
  );
  assert.equal(status.pendingCount, 0, "Pending storage operation");
  assert.equal(status.quarantineCount, 0, "Quarantined storage state");
  assert.equal(status.manualRecoveryRequired, false, "Manual recovery is required");
  assert.equal(status.gcBlocked, false, "Storage GC is blocked");
  assert(status.bootSessionId, "Missing storage boot identity");
}

// Metadata is read only. Ownership tokens never enter evidence files.
export async function inventory(receiptPath, status) {
  healthy(status);
  await noLinks(receiptPath);
  const receiptBytes = await readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.userSid, status.userSid, "Receipt/status user mismatch");
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(path.resolve(receipt.storeRoot), path.dirname(path.resolve(receiptPath)));
  assert(/^S-1-[0-9-]+$/.test(receipt.userSid), "Invalid user SID");
  const root = inside(receipt.storeRoot, path.join(receipt.storeRoot, receipt.userSid));
  const children = [];
  for (const dir of ["leases", "retained", "children", "pending", "quarantine"]) {
    await noLinks(path.join(root, dir));
  }
  for (const name of (await readdir(path.join(root, "leases"))).sort()) {
    assert(name.endsWith(".json"), "Unexpected lease entry");
    const bytes = await readFile(path.join(root, "leases", name));
    const lease = JSON.parse(bytes);
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(lease.leaseId));
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(lease.runId));
    assert.equal(name, `${lease.leaseId}.json`);
    assert.equal(
      lease.retained,
      true,
      "Only quiescent retained children may coexist with this test",
    );
    const childPath = path.join(root, "children", `${lease.leaseId}.vhdx`);
    assert.equal(path.resolve(lease.childPath), childPath);
    const retainedPath = path.join(root, "retained", `${lease.runId}.json`);
    for (const target of [childPath, retainedPath, path.join(root, "leases", name)])
      await noLinks(target);
    const retainedBytes = await readFile(retainedPath);
    const retained = JSON.parse(retainedBytes);
    assert.equal(retained.leaseId, lease.leaseId);
    assert.equal(retained.runId, lease.runId);
    const child = await lstat(childPath, { bigint: true });
    assert(child.isFile(), "Child is not a regular VHDX file");
    children.push({
      leaseId: lease.leaseId,
      runId: lease.runId,
      childPath,
      leaseHash: digest(bytes),
      retainedHash: digest(retainedBytes),
      fileId: `${child.dev}:${child.ino}`,
      size: String(child.size),
      modified: String(child.mtimeNs),
    });
  }
  assert.equal(
    children.length,
    status.retainedChildCount,
    "Status/lease inventory changed or incomplete",
  );
  assert.deepEqual(
    (await readdir(path.join(root, "children"))).sort(),
    children.map((c) => `${c.leaseId}.vhdx`).sort(),
  );
  assert.deepEqual(
    (await readdir(path.join(root, "retained"))).sort(),
    children.map((c) => `${c.runId}.json`).sort(),
  );
  assert.deepEqual(await readdir(path.join(root, "pending")), []);
  assert.deepEqual(await readdir(path.join(root, "quarantine")), []);
  return { receiptHash: digest(receiptBytes), bootSessionId: status.bootSessionId, children };
}

export function preserved(baseline, current, ownedLeaseIds = [], allowReboot = false) {
  assert.equal(current.receiptHash, baseline.receiptHash, "Installed service receipt changed");
  if (!allowReboot)
    assert.equal(
      current.bootSessionId,
      baseline.bootSessionId,
      "Storage service restarted during the test",
    );
  const ids = new Set(ownedLeaseIds);
  assert.equal(ids.size, ownedLeaseIds.length, "Duplicate test lease identity");
  assert(
    baseline.children.every((child) => !ids.has(child.leaseId)),
    "Test lease collides with pre-existing storage",
  );
  assert.deepEqual(
    current.children.filter((child) => !ids.has(child.leaseId)),
    baseline.children,
    "Pre-existing storage changed, or an unowned child appeared; stop without cleanup",
  );
  assert.equal(
    current.children.length,
    baseline.children.length + ids.size,
    "Test child missing or unexpected storage present",
  );
}

export function rebooted(before, after) {
  assert(before.windowsBoot && after.windowsBoot && before.storageBoot && after.storageBoot);
  assert.notEqual(
    before.windowsBoot,
    after.windowsBoot,
    "Windows has not rebooted; checkpoint remains pending",
  );
  assert.notEqual(before.storageBoot, after.storageBoot, "Storage boot identity did not change");
}
