import assert from "node:assert/strict";
import { lstat, rename, mkdir, readdir, cp, copyFile, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { plainDirectory } from "../update/stage-release.mjs";
import { inventoryTree } from "./fresh-install.mjs";
import { sha256 } from "../update/release-manifest.mjs";

/** Antivirus/indexer handles can briefly deny the final build rename. Retry
 * only that rename, with both owned paths rechecked; never overwrite or delete. */
export async function publishAssembly(
  staging,
  destination,
  { move = rename, wait = () => setTimeout(250), allowCopy = false } = {},
) {
  staging = path.resolve(staging);
  destination = path.resolve(destination);
  assert.equal(path.dirname(staging), path.dirname(destination));
  assert.equal(path.basename(staging), "staging");
  assert.equal(path.basename(destination), "HoneyBee");
  for (let attempt = 0; ; attempt++) {
    await plainDirectory(staging);
    try {
      await lstat(destination);
      throw new Error("Assembly destination already exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await move(staging, destination);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      if (attempt === 19) {
        if (!allowCopy) throw error;
        // This is build-artifact publication, never installation activation.
        // Some scanners retain a child handle without FILE_SHARE_DELETE. Copy
        // into a new owned output and publish current.json only after verifying
        // every other payload byte; preserve the locked staging as evidence.
        const parent = path.dirname(staging);
        assert.equal(path.basename(path.dirname(parent)), "installations");
        assert.equal(path.basename(path.dirname(path.dirname(parent))), "output");
        assert(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-[A-Za-z0-9]+$/u.test(path.basename(parent)));
        const expected = await inventoryTree(staging);
        await plainDirectory(staging);
        await mkdir(destination); // Existing destinations always refuse, even empty.
        for (const name of await readdir(staging))
          if (name !== "current.json")
            await cp(path.join(staging, name), path.join(destination, name), {
              recursive: true,
              errorOnExist: true,
              force: false,
              dereference: false,
            });
        assert.deepEqual(
          await inventoryTree(staging),
          expected,
          "Assembly source changed during copy",
        );
        for (const [name, digest] of Object.entries(expected))
          if (name !== "current.json") {
            const file = path.join(destination, name);
            await plainDirectory(path.dirname(file));
            const info = await lstat(file);
            assert(info.isFile() && !info.isSymbolicLink());
            assert.equal(
              sha256(await readFile(file)),
              digest,
              "Assembly candidate changed before pointer publication",
            );
          }
        await copyFile(
          path.join(staging, "current.json"),
          path.join(destination, "current.json"),
          constants.COPYFILE_EXCL,
        );
        assert.deepEqual(
          await inventoryTree(destination),
          expected,
          "Assembly copy differs from source",
        );
        const pointer = await open(path.join(destination, "current.json"), "r+");
        try {
          await pointer.sync();
        } finally {
          await pointer.close();
        }
        return;
      }
    }
    await wait();
  }
}
