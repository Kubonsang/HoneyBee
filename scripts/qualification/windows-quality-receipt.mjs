import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { inventory, git, digest } from "./release-verification.mjs";

const [directoryArg, outcome] = process.argv.slice(2);
assert(directoryArg && outcome, "Evidence directory and job outcome required");
const directory = path.resolve(directoryArg);
const root = path.resolve(import.meta.dirname, "../..");
const source = await inventory(root);
let coverage;
try {
  coverage = JSON.parse(
    execFileSync(
      process.execPath,
      ["tests/docker/summarize.mjs", path.join(directory, "windows-suite.log")],
      { cwd: root, encoding: "utf8" },
    ),
  ).coverage;
} catch {
  /* Missing audit remains failed, never a skip. */
}
const attachments = [];
for (const name of await readdir(directory)) {
  if (!/\.(log|txt)$/u.test(name)) continue;
  attachments.push({ path: name, sha256: digest(await readFile(path.join(directory, name))) });
}
const receipt = {
  schemaVersion: 1,
  lane: "windows",
  source: { commit: git(root, ["rev-parse", "HEAD"]), inventorySha256: source.sha256 },
  status:
    outcome === "success" && coverage?.unexpectedSkips === 0 && source.unclassified.length === 0
      ? "passed"
      : "failed",
  environment: {
    platform: process.platform,
    runnerOS: process.env.RUNNER_OS,
    image: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    runId: process.env.GITHUB_RUN_ID,
  },
  coverage,
  unexpectedSkips: coverage?.unexpectedSkips ?? null,
  attachments,
  completedAt: new Date().toISOString(),
  nativeWindowsQualification: false,
};
await writeFile(path.join(directory, "windows.json"), JSON.stringify(receipt, null, 2) + "\n", {
  flag: "wx",
});
if (receipt.status !== "passed") process.exitCode = 1;
