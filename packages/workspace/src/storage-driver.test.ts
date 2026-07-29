import { describe, expect, it } from "vitest";

import type { StorageDriver, StoragePreparation, StorageVerification } from "./index.js";

const verification: StorageVerification = {
  valid: true,
  logicalBytes: 1_024,
  physicalBytes: 512,
  fileCount: 4,
  issues: [],
};

const preparation: StoragePreparation = {
  driverId: "fixture",
  sourcePath: "D:\\LibraryBase",
  destinationPath: "D:\\Workspace\\Library",
  logicalBytes: verification.logicalBytes,
  physicalBytes: 512,
  fileCount: verification.fileCount,
  verification,
};

describe("StorageDriver", () => {
  it("keeps optimized and fallback adapters behind one contract", async () => {
    const driver: StorageDriver = {
      capability: async () => ({
        ok: true,
        value: {
          driverId: "fixture",
          available: true,
          supportsCopyOnWrite: false,
          supportsIncrementalPreparation: false,
          supportsProgress: true,
          supportsCancellation: true,
          reportsPhysicalBytes: true,
        },
      }),
      prepare: async () => ({ ok: true, value: preparation }),
      verify: async () => ({ ok: true, value: verification }),
      cleanup: async () => ({ ok: true, value: undefined }),
    };

    const capability = await driver.capability({
      sourcePath: preparation.sourcePath,
      destinationPath: preparation.destinationPath,
    });
    const prepared = await driver.prepare({
      sourcePath: preparation.sourcePath,
      destinationPath: preparation.destinationPath,
    });
    const verified = await driver.verify({
      sourcePath: preparation.sourcePath,
      destinationPath: preparation.destinationPath,
    });
    const cleaned = await driver.cleanup({
      destinationPath: preparation.destinationPath,
    });

    expect(capability.ok && capability.value.available).toBe(true);
    expect(prepared.ok && prepared.value.verification.valid).toBe(true);
    expect(verified.ok && verified.value.fileCount).toBe(4);
    expect(cleaned).toEqual({ ok: true, value: undefined });
  });
});
