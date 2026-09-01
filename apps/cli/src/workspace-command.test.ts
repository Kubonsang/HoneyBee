import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
      ok: true,
      projects: [{ projectId: project.projectId, unityProjectPath: source }],
    });

    const help = await runCli(["--help"], root);
    expect(help.stdout).toContain("Workspace Core for Unity projects");
    expect(help.stdout).not.toContain("Run a deterministic two-process");

    const legacy = await runCli(["demo", "--task", "blocked"], root);
    expect(legacy.exitCode).toBe(1);
    expect(JSON.parse(legacy.stderr)).toMatchObject({ code: "cli.unknown-command" });

    const forwardedHelp = await runCli(
      ["workspace", "launch", "missing", "codex", "--", "--help"],
      root,
    );
    expect(forwardedHelp.exitCode).toBe(1);
    expect(forwardedHelp.stdout).not.toContain("Workspace Core for Unity projects");
    expect(JSON.parse(forwardedHelp.stderr)).toMatchObject({ code: "workspace.not-found" });
  });
});
