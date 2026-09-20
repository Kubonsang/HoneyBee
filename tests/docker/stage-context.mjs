import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inventory,
  digest,
  sourceDigest,
  safeFile,
} from "../../scripts/qualification/release-verification.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const target = path.resolve(process.argv[2]);
assert(target.startsWith(path.join(root, "output") + path.sep), "Invalid context path");
await mkdir(target, { recursive: false });
assert(
  (await realpath(target)).startsWith((await realpath(root)) + path.sep),
  "Context escapes repository",
);
const source = await inventory(root);
assert.equal(source.unclassified.length, 0, "Unclassified tests cannot be omitted from context");
const manifest = [];
for (const item of source.files) {
  const file = item.file;
  const input = await safeFile(root, file);
  const bytes = await readFile(input);
  assert.equal(sourceDigest(bytes), item.sha256, "Source changed during context staging");
  const destination = path.join(target, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
  manifest.push({ file, bytes: bytes.length, sha256: digest(bytes) });
}
await writeFile(
  path.join(target, "source-inventory.json"),
  JSON.stringify({ sourceInventorySha256: source.sha256, files: manifest }, null, 2),
);
console.log(
  JSON.stringify({
    files: manifest.length,
    bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
    target,
    sourceInventorySha256: source.sha256,
  }),
);
