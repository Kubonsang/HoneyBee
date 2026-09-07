import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
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
  it("previews new text, empty and binary files without treating an empty HEAD diff as clean", async () => {
    const { workspace, git } = await fixture();
    await writeFile(path.join(workspace.workspacePath, "new 한글.txt"), "새 파일\n");
    expect(await readDiff(workspace, "new 한글.txt")).toMatchObject({
      kind: "untracked",
      content: "새 파일\n",
    });
    await writeFile(path.join(workspace.workspacePath, "empty.txt"), "");
    expect(await readDiff(workspace, "empty.txt")).toMatchObject({
      kind: "untracked",
      content: "",
    });
    await writeFile(path.join(workspace.workspacePath, "binary.bin"), Buffer.from([0, 1, 2]));
    expect(await readDiff(workspace, "binary.bin")).toMatchObject({ kind: "binary", content: "" });
    await writeFile(path.join(workspace.workspacePath, "large.txt"), "staged\n");
    await git("add", "large.txt");
    await writeFile(path.join(workspace.workspacePath, "large.txt"), "before\n");
    expect(await readDiff(workspace, "large.txt")).toMatchObject({ kind: "empty", content: "" });
    expect((await git("status", "--porcelain")).stdout).toContain("MM large.txt");
  });
  it("does not preview files through a directory junction outside the Workspace", async () => {
    const { workspace } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "honeybee-preview-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "must not be returned");
    const linked = path.join(workspace.workspacePath, "linked");
    await symlink(outside, linked, "junction");
    // Git may enumerate the junction as a directory on Windows. Either way,
    // it must never become a general-purpose file reader outside the worktree.
    try {
      expect((await readDiff(workspace, "linked/secret.txt")).content).not.toContain(
        "must not be returned",
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "git.diff-path-invalid" });
    }
    await rm(linked);
  });
  it("bounds untracked previews and retains UTF-8 characters at the limit", async () => {
    const { workspace } = await fixture();
    await mkdir(path.join(workspace.workspacePath, "new"));
    await writeFile(path.join(workspace.workspacePath, "new/large.txt"), "한글\n".repeat(180_000));
    const preview = await readDiff(workspace, "new/large.txt");
    expect(preview.kind).toBe("untracked");
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.content)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(preview.content).not.toContain("\ufffd");
  });
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
