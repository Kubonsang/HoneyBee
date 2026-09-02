import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];

const runCli = (
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace CLI", () => {
  it("registers and lists a Unity project without activating legacy Run behavior", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-cli-"));
    roots.push(root);
    const source = path.join(root, "source");
    const workspaces = path.join(root, "workspaces");
    const dataRoot = path.join(root, "registry");
    await Promise.all(
      ["Assets", "Packages", "ProjectSettings"].map((entry) =>
        mkdir(path.join(source, entry), { recursive: true }),
      ),
    );
    await execFileAsync("git.exe", ["init", "-b", "main", source], { windowsHide: true });

    const initialized = await runCli(
      [
        "project",
        "init",
        source,
        "--workspace-root",
        workspaces,
        "--storage-command",
        process.execPath,
        "--data-root",
        dataRoot,
        "--json",
      ],
      root,
    );
    expect(initialized.exitCode).toBe(0);
    const project = (JSON.parse(initialized.stdout) as { project: { projectId: string } }).project;
    expect(project.projectId).toBeTypeOf("string");

    const listed = await runCli(["project", "list", "--data-root", dataRoot, "--json"], root);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      projects: [{ projectId: project.projectId, unityProjectPath: await realpath(source) }],
    });
    expect(listed.stdout).not.toContain("storageCommand");

    const cache = await runCli(["cache", "status", "--data-root", dataRoot, "--json"], root);
    expect(JSON.parse(cache.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      projectId: project.projectId,
      state: "missing",
      cache: null,
    });
    const workspaceList = await runCli(
      ["workspace", "list", "--data-root", dataRoot, "--json"],
      root,
    );
    expect(JSON.parse(workspaceList.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      workspaces: [],
    });

    const help = await runCli(["--help"], root);
    expect(help.stdout).toContain("Unity parallel Workspace provider");
    expect(help.stdout).not.toContain("Run a deterministic two-process");
    expect(help.stdout).not.toContain("workspace launch");

    const legacy = await runCli(["demo", "--task", "blocked"], root);
    expect(legacy.exitCode).toBe(1);
    expect(JSON.parse(legacy.stderr)).toMatchObject({ code: "cli.unknown-command" });

    const removedLaunch = await runCli(
      ["workspace", "launch", "missing", "codex", "--", "--help"],
      root,
    );
    expect(removedLaunch.exitCode).toBe(1);
    expect(JSON.parse(removedLaunch.stderr)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      code: "cli.unknown-command",
    });
  });
});
