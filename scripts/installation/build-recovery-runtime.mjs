import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const repo = path.resolve(import.meta.dirname, "../..");
assert(process.argv.length === 3, "Provide the approved assembled source installation");
const source = path.resolve(process.argv[2]);
const current = JSON.parse(await readFile(path.join(source, "current.json")));
assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/u.test(current.activeVersion));
const release = path.join(source, "versions", current.activeVersion);
assert.equal(
  JSON.parse(await readFile(path.join(release, "installation.json"))).activity?.protocol,
  1,
);
const base = path.join(repo, "output/recovery-runtime");
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(path.join(base, "build-"));
const copy = async (from, name) => {
  await mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
  await cp(from, path.join(runtime, name), { recursive: true, force: false, errorOnExist: true });
};
for (const name of [
  "scripts/update",
  "scripts/recovery",
  "packages/core/dist",
  "packages/core/package.json",
  "output/update-tools",
])
  await copy(path.join(repo, name), name);
for (const name of ["node.exe", "LICENSE"])
  await copy(path.join(release, "runtime", name), "runtime/" + name);
await copy(path.join(repo, "apps/desktop/resources/update-trust-v1.json"), "update-trust.json");
const inventory = async (root) => {
  const files = {};
  const walk = async (relative = "") => {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      assert(!item.isSymbolicLink());
      const name = relative ? relative + "/" + item.name : item.name;
      if (item.isDirectory()) await walk(name);
      else {
        assert(item.isFile());
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(path.join(root, name))) hash.update(bytes);
        files[name] = hash.digest("hex");
      }
    }
  };
  await walk();
  return files;
};
await writeFile(
  path.join(runtime, "approved-source.json"),
  JSON.stringify({
    schemaVersion: 1,
    version: current.activeVersion,
    launchSha256: current.manifestSha256,
    files: await inventory(release),
  }),
);
const bytes = JSON.stringify({ schemaVersion: 1, files: await inventory(runtime) });
assert(Buffer.byteLength(bytes) <= 65536, "Recovery inventory too large");
await writeFile(path.join(runtime, "manifest.json"), bytes);
await writeFile(
  path.join(base, "candidate.json"),
  JSON.stringify(
    { runtime, manifestSha256: createHash("sha256").update(bytes).digest("hex") },
    null,
    2,
  ),
);
process.stdout.write(runtime + "\n");
