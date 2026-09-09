import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

import { WorkspaceCoreError } from "./workspace-types.js";

export interface WorkspaceBaseCommitV1 {
  readonly commit: string;
  readonly subject: string;
  readonly author: string;
  readonly authoredAt: string;
}

export interface WorkspaceBaseRefV1 {
  readonly reference: string;
  readonly label: string;
  readonly kind: "branch" | "remote" | "tag";
}

export interface WorkspaceBaseRefsV1 {
  readonly head: WorkspaceBaseCommitV1;
  readonly currentBranch: string | null;
  readonly refs: readonly WorkspaceBaseRefV1[];
  readonly nextOffset: number | null;
}

export interface WorkspaceBaseHistoryV1 {
  readonly tip: string;
  readonly commits: readonly WorkspaceBaseCommitV1[];
  readonly nextOffset: number | null;
}

const FORMAT = "%H%x00%s%x00%an%x00%aI";
const OFFSET_MAX = 100_000;

const checkOffset = (offset: number): void => {
  if (!Number.isInteger(offset) || offset < 0 || offset > OFFSET_MAX)
    throw new WorkspaceCoreError("git.invalid-page", "Invalid history or reference page.");
};

const git = async (root: string, args: readonly string[]): Promise<string> => {
  const physicalRoot = await realpath(root);
  return new Promise((resolve, reject) => {
    execFile(
      "git.exe",
      ["-c", `safe.directory=${physicalRoot.replaceAll("\\", "/")}`, ...args],
      {
        cwd: physicalRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new WorkspaceCoreError(
              "git.base-query-failed",
              stderr.trim() || "Could not read Git history within the query limit.",
              { cause: error },
            ),
          );
        } else resolve(stdout.trimEnd());
      },
    );
  });
};

const parseCommits = (output: string): WorkspaceBaseCommitV1[] =>
  output === ""
    ? []
    : output.split(/\r?\n/u).map((line) => {
        const [commit, subject, author, authoredAt] = line.split("\0");
        if (
          commit === undefined ||
          !/^[a-f0-9]{40,64}$/u.test(commit) ||
          subject === undefined ||
          author === undefined ||
          authoredAt === undefined
        )
          throw new WorkspaceCoreError(
            "git.base-query-failed",
            "Git returned invalid commit metadata.",
          );
        return { commit, subject, author, authoredAt };
      });

export const resolveWorkspaceBase = async (
  root: string,
  reference: string,
): Promise<WorkspaceBaseCommitV1> => {
  if (reference.trim() === "" || reference.length > 255 || /[\0\r\n]/u.test(reference))
    throw new WorkspaceCoreError("git.invalid-base", "Choose a valid branch, tag, or commit.");
  const commit = await git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${reference}^{commit}`,
  ]);
  const result = parseCommits(
    await git(root, ["log", "-1", "--no-show-signature", `--format=${FORMAT}`, commit, "--"]),
  )[0];
  if (result === undefined)
    throw new WorkspaceCoreError("git.invalid-base", "The selected commit is unavailable.");
  return result;
};

export const listWorkspaceBaseRefs = async (
  root: string,
  offset = 0,
): Promise<WorkspaceBaseRefsV1> => {
  checkOffset(offset);
  const [head, currentBranch, output] = await Promise.all([
    resolveWorkspaceBase(root, "HEAD"),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, [
      "for-each-ref",
      "--sort=refname",
      `--count=${offset + 101}`,
      "--format=%(refname)%00%(symref)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]),
  ]);
  const rows = output === "" ? [] : output.split(/\r?\n/u);
  const refs = rows.slice(offset, offset + 100).flatMap((line): WorkspaceBaseRefV1[] => {
    const [reference, symbolic] = line.split("\0");
    if (reference === undefined || symbolic !== "") return [];
    const kind = reference.startsWith("refs/heads/")
      ? "branch"
      : reference.startsWith("refs/remotes/")
        ? "remote"
        : "tag";
    return [{ reference, label: reference.replace(/^refs\/(heads|remotes|tags)\//u, ""), kind }];
  });
  return {
    head,
    currentBranch: currentBranch === "HEAD" ? null : currentBranch,
    refs,
    nextOffset: rows.length > offset + 100 && offset + 100 <= OFFSET_MAX ? offset + 100 : null,
  };
};

export const listWorkspaceBaseHistory = async (
  root: string,
  reference: string,
  offset = 0,
): Promise<WorkspaceBaseHistoryV1> => {
  checkOffset(offset);
  const tip = await resolveWorkspaceBase(root, reference);
  const commits = parseCommits(
    await git(root, [
      "log",
      "-51",
      `--skip=${offset}`,
      "--no-show-signature",
      `--format=${FORMAT}`,
      tip.commit,
      "--",
    ]),
  );
  return {
    tip: tip.commit,
    commits: commits.slice(0, 50),
    nextOffset: commits.length > 50 && offset + 50 <= OFFSET_MAX ? offset + 50 : null,
  };
};
