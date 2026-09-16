import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Cooperative launch gate only; the pinned recovery runtime authorizes bytes. */
export async function assertApplicationRepairAdmission(root: string): Promise<void> {
  const base = path.join(root, "update/app-repairs");
  const read = async (name: string): Promise<Buffer> => {
    const info = await lstat(name);
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 65536);
    assert.equal((await realpath(name)).toLowerCase(), path.resolve(name).toLowerCase());
    const bytes = await readFile(name);
    assert(bytes.length <= 65536);
    return bytes;
  };
  let names: string[];
  try {
    names = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assert(names.length <= 256);
  assert.equal((await realpath(base)).toLowerCase(), path.resolve(base).toLowerCase());
  for (const name of names) {
    assert(/^repair-[A-Za-z0-9]+$/u.test(name), "Unknown application Repair entry");
    const directory = path.join(base, name);
    assert((await lstat(directory)).isDirectory());
    assert.equal((await realpath(directory)).toLowerCase(), path.resolve(directory).toLowerCase());
    let intent: Buffer;
    try {
      intent = await read(path.join(directory, "intent.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const record = JSON.parse(intent.toString("utf8")) as {
      schemaVersion?: unknown;
      version?: unknown;
      sourcePointerSha256?: unknown;
    };
    assert.deepEqual(Object.keys(record).sort(), [
      "schemaVersion",
      "sourcePointerSha256",
      "version",
    ]);
    assert.equal(record.schemaVersion, 1);
    assert(
      typeof record.version === "string" && /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(record.version),
    );
    assert(
      typeof record.sourcePointerSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(record.sourcePointerSha256),
    );
    const complete = JSON.parse(
      (await read(path.join(directory, "complete.json"))).toString("utf8"),
    ) as unknown;
    assert.deepEqual(
      complete,
      { schemaVersion: 1, intentSha256: createHash("sha256").update(intent).digest("hex") },
      "HoneyBee application Repair must complete before launch",
    );
  }
}
