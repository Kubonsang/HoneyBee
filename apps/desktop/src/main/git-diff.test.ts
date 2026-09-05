import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readDiff, MAX_DIFF_BYTES } from "./git-diff.js";

const exec = promisify(execFile);
const roots: string[] = [];
const fixture = async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "honeybee-diff-"));
  roots.push(workspacePath);
  const git = (...args: string[]) =>
    exec("git.exe", ["-c", `safe.directory=${workspacePath.replaceAll("\\", "/")}`, ...args], {
      cwd: workspacePath,
      windowsHide: true,
    });
  await git("init");
  await git("config", "core.autocrlf", "false");
  await writeFile(path.join(workspacePath, "한글 [a] file.txt"), "before\n");
  await writeFile(path.join(workspacePath, "large.txt"), "before\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  return { workspace: { workspaceId: "test", workspacePath }, git };
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded Git diff", () => {
  it("reads literal Unicode paths, staged/unstaged changes, and renames from a real repository", async () => {
    const { workspace, git } = await fixture();
    await writeFile(path.join(workspace.workspacePath, "한글 [a] file.txt"), "staged\n");
    await git("add", ".");
    await writeFile(path.join(workspace.workspacePath, "한글 [a] file.txt"), "staged\nunstaged\n");
    const diff = await readDiff(workspace, "한글 [a] file.txt");
    expect(diff.content).toContain("+staged");
    expect(diff.content).toContain("+unstaged");
    await git("mv", "large.txt", "renamed file.txt");
    expect((await readDiff(workspace, "renamed file.txt")).content).toContain("before");
    await writeFile(path.join(workspace.workspacePath, "untracked.txt"), "not tracked\n");
    expect((await readDiff(workspace)).content).not.toContain("not tracked");
    await expect(readDiff(workspace, "../outside")).rejects.toMatchObject({
      code: "git.diff-path-invalid",
    });
    await expect(readDiff(workspace, "C:\\outside")).rejects.toMatchObject({
      code: "git.diff-path-invalid",
    });
  });
  it("truncates output larger than the old process buffer without breaking UTF-8", async () => {
    const { workspace } = await fixture();
    await writeFile(
      path.join(workspace.workspacePath, "large.txt"),
      "한글 changed line\n".repeat(180_000),
    );
    const diff = await readDiff(workspace);
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.content)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(diff.content).toContain("한글 changed line");
    expect(diff.content).not.toContain("\ufffd");
  });
});
