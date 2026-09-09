import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import {
  listWorkspaceBaseHistory,
  listWorkspaceBaseRefs,
  resolveWorkspaceBase,
} from "./workspace-bases.js";

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (root: string, ...args: string[]) =>
  (
    await exec(
      "git.exe",
      [
        "-c",
        `safe.directory=${root.replaceAll("\\", "/")}`,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: root, windowsHide: true },
    )
  ).stdout.trim();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

it("pages bounded history from an immutable tip and handles detached HEAD", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-bases-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  const tree = await git(root, "write-tree");
  let tip: string | undefined;
  for (let index = 0; index < 55; index++)
    tip = await git(root, "commit-tree", tree, ...(tip ? ["-p", tip] : []), "-m", `기록 ${index}`);
  if (tip === undefined) throw new Error("No fixture tip");
  await git(root, "update-ref", "refs/heads/main", tip);
  const first = await listWorkspaceBaseHistory(root, "main");
  expect(first.commits).toHaveLength(50);
  expect(first.nextOffset).toBe(50);
  expect(first.commits[0]?.subject).toBe("기록 54");
  const newer = await git(root, "commit-tree", tree, "-p", tip, "-m", "new tip");
  await git(root, "update-ref", "refs/heads/main", newer);
  const next = await listWorkspaceBaseHistory(root, first.tip, 50);
  expect(next.commits).toHaveLength(5);
  expect(next.commits[0]?.subject).toBe("기록 4");
  expect(next.nextOffset).toBeNull();
  expect(
    next.commits.every((item) => !first.commits.some((old) => old.commit === item.commit)),
  ).toBe(true);
  for (let index = 0; index < 105; index++)
    await git(root, "update-ref", `refs/tags/release-${String(index).padStart(3, "0")}`, tip);
  await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git(root, "update-ref", "refs/remotes/origin/main", tip);
  const refs = await listWorkspaceBaseRefs(root);
  expect(refs.refs.length).toBeLessThanOrEqual(100);
  expect(refs.nextOffset).toBe(100);
  expect(refs.refs.some((item) => item.reference === "refs/remotes/origin/HEAD")).toBe(false);
  const more = await listWorkspaceBaseRefs(root, 100);
  expect(more.nextOffset).toBeNull();
  expect(new Set([...refs.refs, ...more.refs].map((item) => item.reference)).size).toBe(107);
  await git(root, "checkout", "--detach", tip);
  expect((await listWorkspaceBaseRefs(root)).currentBranch).toBeNull();
  await expect(listWorkspaceBaseHistory(root, tip, -1)).rejects.toMatchObject({
    code: "git.invalid-page",
  });
  await expect(listWorkspaceBaseRefs(root, 100_001)).rejects.toMatchObject({
    code: "git.invalid-page",
  });
  await expect(resolveWorkspaceBase(root, "\n")).rejects.toMatchObject({
    code: "git.invalid-base",
  });
}, 30_000);
