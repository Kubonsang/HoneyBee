import { describe, expect, it } from "vitest";
import { parseWorkspaceUsage } from "./workspace-usage.js";

describe("workspace usage contract", () => {
  const report = {
    schemaVersion: 1,
    measuredAt: "2026-09-08T00:00:00Z",
    knownAllocatedBytes: 0,
    complete: false,
    entries: [
      {
        id: "child",
        kind: "child-vhdx",
        scope: "workspace",
        workspaceId: "work",
        logicalBytes: null,
        allocatedBytes: null,
        fileCount: 0,
        omittedLinks: 0,
        complete: false,
        errors: ["Access denied"],
      },
    ],
  };
  it("preserves inaccessible storage as unknown", () => {
    expect(parseWorkspaceUsage(report).entries[0]?.allocatedBytes).toBeNull();
    expect(parseWorkspaceUsage(report).complete).toBe(false);
  });
  it("rejects invalid byte counts and malformed helper output", () => {
    for (const invalid of [-1, NaN, Number.MAX_SAFE_INTEGER + 1, "0"])
      expect(() => parseWorkspaceUsage({ ...report, knownAllocatedBytes: invalid })).toThrow(
        "invalid data",
      );
    expect(() => parseWorkspaceUsage({ ...report, measuredAt: "yesterday" })).toThrow();
    expect(() =>
      parseWorkspaceUsage({ ...report, entries: [{ ...report.entries[0], allocatedBytes: -1 }] }),
    ).toThrow();
  });
});
