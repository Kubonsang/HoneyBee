import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const scannerPath = fileURLToPath(new URL("./check-no-secrets.mjs", import.meta.url));
const directories = [];

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("public-source security scan", () => {
  it("scans index content when a tracked path is absent from the worktree", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honeybee-security-scan-"));
    directories.push(directory);
    git(directory, ["init"]);
    const trackedPath = path.join(directory, "tracked.txt");
    const token = ["ghp", "_", "A".repeat(24)].join("");
    writeFileSync(trackedPath, `${token}\n`, "utf8");
    git(directory, ["add", "tracked.txt"]);
    unlinkSync(trackedPath);

    const result = spawnSync(process.execPath, [scannerPath, "--all"], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tracked.txt:1: possible GitHub token");
  });
});
