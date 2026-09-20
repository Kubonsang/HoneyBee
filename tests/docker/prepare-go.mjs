import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import path from "node:path";

const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: "utf8", stdio: "pipe", ...options });
const overlay = JSON.parse(readFileSync("integrations/storage/external-bee-overlay.json", "utf8"));
const patch = readFileSync("integrations/storage/external-bee.patch");
assert.equal(createHash("sha256").update(patch).digest("hex"), overlay.sha256);
const module = JSON.parse(
  run("go", ["mod", "download", "-json", "github.com/Kubonsang/unity-workspace-storage"], {
    cwd: "tools/workspace-storage-host",
  }),
);
assert(module.Version.endsWith(overlay.baseCommit.slice(0, 12)));
cpSync(module.Dir, "external/storage", { recursive: true, errorOnExist: true, force: false });
function writable(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) writable(file);
    else chmodSync(file, 0o644);
  }
}
writable("external/storage");
// Apply from the repository root with an explicit destination. From a nested
// working directory Git can silently skip all paths outside that directory.
const apply = (patchPath, ...flags) =>
  run("git", ["apply", ...flags, "--directory=external/storage", patchPath]);
apply("integrations/storage/external-bee.patch", "--check");
apply("integrations/storage/external-bee.patch");
// Upstream's timer-backed fake counter has no synchronization. Repair only the
// test fixture; never alter production hb15 source or its pinned overlay identity.
const testPatch = "tests/docker/upstream-test-race.patch";
const changedTestFiles = run("git", ["apply", "--numstat", testPatch])
  .trim()
  .split(/\r?\n/)
  .map((line) => line.split("\t")[2])
  .sort();
assert.deepEqual(changedTestFiles, ["workspace/broker_test.go", "workspace/removal_test.go"]);
apply(testPatch, "--check");
apply(testPatch);
// Reverse checks prove the pinned patches actually reached the copied source.
apply(testPatch, "--reverse", "--check");
apply("integrations/storage/external-bee.patch", "--reverse", "--check");
const testOnlyPatchSha256 = createHash("sha256")
  .update(readFileSync("tests/docker/upstream-test-race.patch"))
  .digest("hex");
const modules = [
  "./external/storage",
  "./tools/workspace-storage-host",
  "./tools/honeybee-launcher",
  "./tools/honeybee-update-package",
];
run("go", ["work", "init", ...modules]);
for (const cwd of modules) run("go", ["mod", "download", "all"], { cwd });
console.log(
  JSON.stringify({
    overlay,
    module: module.Version,
    checksum: module.Sum,
    testOnlyPatchSha256,
    modules,
  }),
);
