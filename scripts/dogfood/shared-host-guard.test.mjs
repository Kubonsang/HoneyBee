import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inside,
  disjoint,
  preserved,
  rebooted,
  healthy,
  inventory,
  noLinks,
  redactUnityLog,
} from "./shared-host-guard.mjs";

const original = {
  leaseId: "original",
  leaseHash: "a",
  retainedHash: "b",
  fileId: "1",
  size: "10",
  modified: "20",
};
const baseline = { receiptHash: "receipt", bootSessionId: "boot1", children: [original] };

describe("shared-host preservation", () => {
  it("rejects original-source and run-directory overlap in either direction", () => {
    expect(() => disjoint("source", "source/test-run")).toThrow();
    expect(() => disjoint("source/test-run", "source")).toThrow();
    expect(() => disjoint("source", "source")).toThrow();
    expect(() => disjoint("source", "source-test-run")).not.toThrow();
  });
  it("removes Unity command-line credentials while keeping validation lines", () => {
    expect(
      redactUnityLog(
        "Date: now\r\n-accessToken\r\nexample-only\r\n-password=example-only\r\nExit 0",
      ),
    ).toBe("Date: now\n-accessToken\n[redacted]\n-password=[redacted]\nExit 0");
  });
  it("accepts only the known original and exact test leases", () => {
    const current = { ...baseline, children: [original, { leaseId: "test" }] };
    expect(() => preserved(baseline, current, ["test"])).not.toThrow();
    expect(() => preserved(baseline, current, [])).toThrow();
    expect(() => preserved(baseline, baseline, ["test"])).toThrow();
    expect(() => preserved(baseline, baseline, ["original"])).toThrow();
  });
  it.each(["leaseHash", "retainedHash", "fileId", "size", "modified"])(
    "rejects original %s changes even at identical counts",
    (key) => {
      expect(() =>
        preserved(baseline, { ...baseline, children: [{ ...original, [key]: "changed" }] }),
      ).toThrow();
    },
  );
  it("rejects service replacement and restart", () => {
    expect(() => preserved(baseline, { ...baseline, receiptHash: "other" })).toThrow();
    expect(() => preserved(baseline, { ...baseline, bootSessionId: "boot2" })).toThrow();
  });
  it("requires both Windows and storage boot identities to change", () => {
    const before = { windowsBoot: "one", storageBoot: "one" };
    expect(() => rebooted(before, { windowsBoot: "one", storageBoot: "two" })).toThrow();
    expect(() => rebooted(before, { windowsBoot: "two", storageBoot: "one" })).toThrow();
    expect(() => rebooted(before, { windowsBoot: "two", storageBoot: "two" })).not.toThrow();
  });
  it("rejects unsafe service state and paths outside the test root", () => {
    const status = {
      activeChildCount: 0,
      retainedChildCount: 1,
      pendingCount: 0,
      quarantineCount: 0,
      manualRecoveryRequired: false,
      gcBlocked: false,
      bootSessionId: "boot",
    };
    expect(() => healthy(status)).not.toThrow();
    expect(() => healthy({ ...status, pendingCount: 1 })).toThrow();
    expect(() => healthy({ ...status, quarantineCount: 1 })).toThrow();
    expect(() => healthy({ ...status, activeChildCount: 1 })).toThrow();
    expect(() => inside("test-root", "test-root/../unrelated")).toThrow();
    expect(() => inside("test-root", "test-root-other/path")).toThrow();
    expect(() => inside("test-root", "test-root")).toThrow();
  });
});

describe("shared-host inventory", () => {
  it("enumerates exact journals and refuses hidden children, malformed paths and status drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hb-shared-guard-"));
    const sid = "S-1-5-21-1001";
    const userRoot = path.join(root, sid);
    const receipt = path.join(root, "install-receipt.json");
    const childPath = path.join(userRoot, "children", "lease-1.vhdx");
    const leasePath = path.join(userRoot, "leases", "lease-1.json");
    const lease = { leaseId: "lease-1", runId: "run-1", retained: true, childPath };
    const status = {
      activeChildCount: 0,
      retainedChildCount: 1,
      pendingCount: 0,
      quarantineCount: 0,
      manualRecoveryRequired: false,
      gcBlocked: false,
      bootSessionId: "boot",
      userSid: sid,
    };
    try {
      for (const dir of ["leases", "retained", "children", "pending", "quarantine"]) {
        await mkdir(path.join(userRoot, dir), { recursive: true });
      }
      await writeFile(receipt, JSON.stringify({ schemaVersion: 2, userSid: sid, storeRoot: root }));
      await writeFile(leasePath, JSON.stringify(lease));
      await writeFile(
        path.join(userRoot, "retained", "run-1.json"),
        JSON.stringify({ leaseId: "lease-1", runId: "run-1" }),
      );
      await writeFile(childPath, "fixture");
      const before = await inventory(receipt, status);
      expect(before.children.map((item) => item.leaseId)).toEqual(["lease-1"]);
      await expect(inventory(receipt, { ...status, retainedChildCount: 0 })).rejects.toThrow();
      await writeFile(path.join(userRoot, "children", "unknown.vhdx"), "fixture");
      await expect(inventory(receipt, status)).rejects.toThrow();
      await rm(path.join(userRoot, "children", "unknown.vhdx"));
      await writeFile(
        leasePath,
        JSON.stringify({ ...lease, childPath: path.join(root, "outside.vhdx") }),
      );
      await expect(inventory(receipt, status)).rejects.toThrow();
      await writeFile(leasePath, JSON.stringify(lease));
      await writeFile(path.join(userRoot, "pending", "unexpected.json"), "{}");
      await expect(inventory(receipt, status)).rejects.toThrow();
    } finally {
      inside(os.tmpdir(), root);
      await noLinks(root);
      await rm(root, { recursive: true });
    }
  });
});
