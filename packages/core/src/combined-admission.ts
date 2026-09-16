import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const transitions: Record<string, readonly string[]> = {
  "": ["Prepared"],
  Prepared: ["ServiceReady", "RollingBack"],
  ServiceReady: ["AppSelected", "RollingBack"],
  AppSelected: ["DesktopReady", "RollingBack"],
  DesktopReady: ["Committing", "RollingBack"],
  Committing: ["Committed", "RollingBack"],
  RollingBack: ["RolledBack"],
  Committed: [],
  RolledBack: [],
};
const plain = async (directory: string): Promise<void> => {
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink());
  assert.equal((await realpath(directory)).toLowerCase(), path.resolve(directory).toLowerCase());
};

/** Check after shared activity admission. Direct managed Desktop/CLI launches
 * obey the same pending-pair boundary as the stable launcher. Doctor uses its
 * existing read-only bypass; this function grants no privileged authority. */
export async function assertCombinedAdmission(root: string, validationId?: string): Promise<void> {
  if (validationId !== undefined) assert(/^[a-f0-9]{64}$/u.test(validationId));
  const parent = path.join(root, "update", "combined");
  try {
    await plain(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && validationId === undefined) return;
    throw error;
  }
  const names = await readdir(parent);
  assert(names.length <= 256, "Combined journal count exceeds bound");
  let pending = 0;
  for (const name of names) {
    assert(/^[a-f0-9]{64}$/u.test(name), "Invalid combined journal name");
    const directory = path.join(parent, name);
    await plain(directory);
    const files = (await readdir(directory)).sort();
    assert(files.length <= 64);
    let state = "",
      previous = name,
      count = 0;
    for (const file of files) {
      if (/^[a-f0-9-]+\.partial$/u.test(file)) continue;
      count++;
      assert(
        count <= 16 && file === `${String(count).padStart(2, "0")}.json`,
        "Incomplete combined journal",
      );
      const target = path.join(directory, file),
        info = await lstat(target);
      assert(info.isFile() && !info.isSymbolicLink() && info.size <= 65536);
      const bytes = await readFile(target);
      assert(bytes.length <= 65536);
      const record = JSON.parse(bytes.toString("utf8")) as {
        schemaVersion?: number;
        identitySha256?: string;
        previousSha256?: string;
        state?: string;
      };
      assert.deepEqual(
        Object.keys(record).sort(),
        ["schemaVersion", "identitySha256", "previousSha256", "state"].sort(),
      );
      assert(
        record.schemaVersion === 1 &&
          record.identitySha256 === name &&
          record.previousSha256 === previous,
      );
      assert(
        typeof record.state === "string" && transitions[state]?.includes(record.state),
        "Invalid combined journal transition",
      );
      state = record.state;
      previous = createHash("sha256").update(bytes).digest("hex");
    }
    if (["Committed", "RolledBack"].includes(state)) continue;
    pending++;
    assert(
      validationId === name && ["AppSelected", "DesktopReady", "Committing"].includes(state),
      "HoneyBee application/service update must finish before normal use.",
    );
  }
  if (validationId !== undefined)
    assert.equal(pending, 1, "Matching pending update required for validation");
}
