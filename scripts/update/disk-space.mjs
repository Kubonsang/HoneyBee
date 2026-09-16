import assert from "node:assert/strict";
import { statfs } from "node:fs/promises";

/** Advisory admission, not a reservation; all later writes must still fail safely. */
export const requireDiskSpace = async (directory, requiredBytes, inspect = statfs) => {
  assert(
    Number.isSafeInteger(requiredBytes) && requiredBytes > 0,
    "Invalid required disk capacity",
  );
  const stats = await inspect(directory, { bigint: true });
  assert(
    typeof stats.bavail === "bigint" && typeof stats.bsize === "bigint" && stats.bsize > 0n,
    "Disk capacity unavailable",
  );
  const availableBytes = (stats.bavail > 0n ? stats.bavail : 0n) * stats.bsize;
  if (availableBytes < BigInt(requiredBytes)) {
    const error = new Error("Insufficient disk space for update download");
    error.code = "ENOSPC";
    throw error;
  }
};
