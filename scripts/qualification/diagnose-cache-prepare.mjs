import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import console from "node:console";

const bundle = "C:\\HoneyBeeQA\\final-integrated-20260914";
const readJson = async (file) => {
  const info = await lstat(file);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024,
    "Unsafe diagnostic JSON",
  );
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
};
const run = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let response;
        try {
          response = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
        } catch {
          // Preserve raw stdout below when the failed command did not return JSON.
        }
        resolve({
          exitCode: error?.code ?? 0,
          ...(response === undefined ? { stdout } : { response }),
          ...(stderr ? { stderr } : {}),
        });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
const inspection = await run("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  path.join(bundle, "scripts/qualification/inspect-integrated-guest.ps1"),
]);
assert.equal(inspection.exitCode, 0);
const guest = inspection.response;
assert.equal(guest.computerName, "DESKTOP-9LT0JVV");
assert.equal(guest.userSid, "S-1-5-21-4199076252-3622841657-4011401391-1001");
assert.equal(guest.elevated, false);
const current = await readJson(path.join(guest.installationRoot, "current.json"));
assert(/^[0-9A-Za-z.-]+$/u.test(current.activeVersion));
const companion = path.join(
  guest.installationRoot,
  "versions",
  current.activeVersion,
  "tools/honeybee-workspace-storage-host.exe",
);
const registry = await readJson(
  path.join(guest.installationRoot, "workspace-core/workspace-registry-v2.json"),
);
assert(
  registry.projects.some((project) => project.projectId === "25e6825e-4c06-4095-8721-0b4cc2acd985"),
  "Failed QA project identity differs",
);
const report = {
  schemaVersion: 1,
  storageReadOnly: true,
  createdAt: new Date().toISOString(),
  guest,
  current,
  registry,
};
report.diagnostic = await run(companion, ["diagnose"]);
report.receipt = await readJson(path.join(guest.storeRoot, "install-receipt.json"));
report.config = await readJson(path.join(guest.storeRoot, "broker-config.json"));
report.hello = await run(
  companion,
  ["control"],
  JSON.stringify({
    schemaVersion: 3,
    operation: "hello",
    requestId: "qa-diagnostic-" + randomUUID(),
  }) + "\n",
);
const requests = path.join(
  process.env.LOCALAPPDATA,
  "unity-workspace-storage/schema2-windows-requests",
);
const candidates = [];
report.cachedRequests = [];
try {
  const info = await lstat(requests);
  assert(info.isDirectory() && !info.isSymbolicLink());
  for (const entry of await readdir(requests, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(requests, entry.name),
      stat = await lstat(file);
    candidates.push({ file, modified: stat.mtimeMs });
  }
  for (const item of candidates.sort((a, b) => b.modified - a.modified).slice(0, 20)) {
    const claim = await readJson(item.file);
    if (!/^hb-parent-begin-[a-f0-9-]+$/u.test(claim.requestId ?? "")) continue;
    // The broker returns an already cached response for this request ID. If it
    // no longer has it, HELLO is harmless: never issue another parent-begin.
    const response = await run(
      companion,
      ["control"],
      JSON.stringify({ schemaVersion: 3, operation: "hello", requestId: claim.requestId }) + "\n",
    );
    report.cachedRequests.push({ requestId: claim.requestId, claimFile: item.file, ...response });
    if (report.cachedRequests.length === 3) break;
  }
} catch (error) {
  report.requestInspectionError = String(error);
}
report.storeLayout = [];
const queue = [{ directory: guest.storeRoot, depth: 0 }];
while (queue.length && report.storeLayout.length < 200) {
  const { directory, depth } = queue.shift();
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (report.storeLayout.length >= 200) break;
      const file = path.join(directory, entry.name),
        stat = await lstat(file);
      report.storeLayout.push({
        path: file,
        directory: stat.isDirectory(),
        reparse: stat.isSymbolicLink(),
        bytes: stat.size,
      });
      if (stat.isDirectory() && !stat.isSymbolicLink() && depth < 2)
        queue.push({ directory: file, depth: depth + 1 });
    }
  } catch (error) {
    report.storeLayout.push({ path: directory, error: String(error) });
  }
}
const directory = path.join(bundle, "Diagnostics", "cache-prepare-" + randomUUID());
await mkdir(directory, { recursive: true });
const evidence = path.join(directory, "diagnostic.json");
await writeFile(evidence, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ evidence, ...report }, null, 2));
