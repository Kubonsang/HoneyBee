import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { VerifiedPatchViewV1 } from "@honeybee/control-plane-contracts";

import {
  DesktopGitActionResultV1Schema,
  DesktopGitSnapshotV1Schema,
  type DesktopGitActionResultV1,
  type DesktopGitSnapshotV1,
  type DesktopGitWorktreeV1,
} from "../shared/ipc.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const pathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const safeIdentifier = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .slice(0, 64);

const workBranch = (runId: string): string => `honeybee/work/${runId}`;
const integrationBranch = (groupRunId: string): string => `honeybee/integration/${groupRunId}`;

interface GitRepository {
  readonly root: string;
  readonly projectRelativePath: string;
  readonly currentBranch: string;
  readonly repositoryKey: string;
}

interface ParsedWorktree {
  path: string;
  head: string;
  branch: string;
}

const contentDigest = (value: Buffer): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class DesktopGitWorktrees {
  readonly #root: string;

  public constructor(userDataDirectory: string) {
    this.#root = path.resolve(userDataDirectory, "git-worktrees");
  }

  public async snapshot(projectPath: string): Promise<DesktopGitSnapshotV1> {
    const repository = await this.#repository(projectPath).catch(() => undefined);
    if (repository === undefined) {
      return DesktopGitSnapshotV1Schema.parse({
        schemaVersion: 1,
        available: false,
        projectPath: path.resolve(projectPath),
        worktrees: [],
        message: "The selected Unity project is not inside a Git worktree.",
      });
    }
    const parsed = this.#parseWorktrees(
      await this.#git(repository.root, ["worktree", "list", "--porcelain"]),
    );
    const worktrees: DesktopGitWorktreeV1[] = [];
    for (const worktree of parsed.slice(0, 128)) {
      const statusText = await this.#git(worktree.path, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const conflict = statusText
        .split(/\r?\n/u)
        .some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /u.test(line));
      const match = /^honeybee\/work\/([0-9a-f-]{36})$/u.exec(worktree.branch);
      worktrees.push({
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
        kind:
          pathKey(worktree.path) === pathKey(repository.root)
            ? "source"
            : worktree.branch.startsWith("honeybee/integration/")
              ? "integration"
              : worktree.branch.startsWith("honeybee/work/")
                ? "work"
                : "other",
        ...(match?.[1] === undefined ? {} : { runId: match[1] }),
        status: conflict ? "conflict" : statusText.trim().length === 0 ? "clean" : "dirty",
      });
    }
    return DesktopGitSnapshotV1Schema.parse({
      schemaVersion: 1,
      available: true,
      projectPath: path.resolve(projectPath),
      repositoryRoot: repository.root,
      currentBranch: repository.currentBranch,
      worktrees,
    });
  }

  public async materialize(
    projectPath: string,
    runId: string,
    groupRunId: string,
    patch: VerifiedPatchViewV1,
  ): Promise<DesktopGitActionResultV1> {
    const repository = await this.#repository(projectPath);
    await this.#assertClean(repository.root);
    if (patch.sourceState !== "clean" || patch.disposition !== "pending") {
      throw codedError(
        "desktop.git-patch-not-pending",
        "Only a pending verified patch with a clean source can become a Work branch.",
      );
    }
    const branch = workBranch(runId);
    const integration = integrationBranch(groupRunId);
    const existing = await this.#branchExists(repository.root, branch);
    if (existing) {
      return this.#result("already-complete", branch, integration, [], projectPath);
    }
    const integrationPath = this.#ownedPath(repository, "integration", groupRunId);
    if (!(await this.#branchExists(repository.root, integration))) {
      await mkdir(path.dirname(integrationPath), { recursive: true });
      await this.#git(repository.root, [
        "worktree",
        "add",
        "-b",
        integration,
        integrationPath,
        "HEAD",
      ]);
    } else if (!(await this.#worktreeForBranch(repository.root, integration))) {
      await mkdir(path.dirname(integrationPath), { recursive: true });
      await this.#git(repository.root, ["worktree", "add", integrationPath, integration]);
    }
    const worktreePath = this.#ownedPath(repository, "work", runId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.#git(repository.root, ["worktree", "add", "-b", branch, worktreePath, integration]);
    const worktreeProject = path.resolve(worktreePath, repository.projectRelativePath);
    if (!inside(worktreePath, worktreeProject)) {
      throw codedError("desktop.git-path-invalid", "The Unity project escaped its Git worktree.");
    }
    try {
      await this.#applyPreview(worktreeProject, patch);
      await this.#git(worktreePath, ["add", "-A", "--", repository.projectRelativePath || "."]);
      const staged = await this.#git(worktreePath, ["diff", "--cached", "--name-only"]);
      if (staged.trim().length === 0) {
        throw codedError("desktop.git-empty-patch", "The verified patch produced no Git changes.");
      }
      await this.#git(worktreePath, [
        "-c",
        "user.name=HoneyBee",
        "-c",
        "user.email=honeybee@local",
        "commit",
        "-m",
        `HoneyBee Work ${safeIdentifier(runId)}`,
      ]);
      return this.#result("materialized", branch, integration, [], projectPath);
    } catch (error) {
      await this.#git(worktreePath, ["reset", "--hard", "HEAD"]).catch(() => undefined);
      if (inside(this.#root, worktreePath)) {
        await this.#git(repository.root, ["worktree", "remove", "--force", worktreePath]).catch(
          () => undefined,
        );
        await this.#git(repository.root, ["branch", "-D", branch]).catch(() => undefined);
      }
      throw error;
    }
  }

  public async merge(
    projectPath: string,
    runId: string,
    groupRunId: string,
  ): Promise<DesktopGitActionResultV1> {
    const repository = await this.#repository(projectPath);
    const branch = workBranch(runId);
    const integration = integrationBranch(groupRunId);
    if (!(await this.#branchExists(repository.root, branch))) {
      throw codedError("desktop.git-worktree-not-ready", "Materialize the verified patch first.");
    }
    const integrationPath = await this.#worktreeForBranch(repository.root, integration);
    if (integrationPath === undefined) {
      throw codedError(
        "desktop.git-integration-missing",
        "The Run integration worktree is missing.",
      );
    }
    const alreadyMerged = await this.#isAncestor(integrationPath, branch, integration);
    if (alreadyMerged) {
      await this.#removeWorktree(repository.root, branch);
      return this.#result("already-complete", branch, integration, [], projectPath);
    }
    await this.#assertClean(integrationPath);
    try {
      await this.#git(integrationPath, ["merge", "--no-ff", "--no-edit", branch]);
      await this.#removeWorktree(repository.root, branch);
      return this.#result("merged", branch, integration, [], projectPath);
    } catch (error) {
      const conflicts = (
        await this.#git(integrationPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")
      )
        .split(/\r?\n/u)
        .filter(Boolean);
      if (conflicts.length === 0) throw error;
      return this.#result("conflict", branch, integration, conflicts, projectPath);
    }
  }

  public async finalize(
    projectPath: string,
    groupRunId: string,
  ): Promise<DesktopGitActionResultV1> {
    const repository = await this.#repository(projectPath);
    const integration = integrationBranch(groupRunId);
    if (!(await this.#branchExists(repository.root, integration))) {
      throw codedError("desktop.git-integration-missing", "The Run integration branch is missing.");
    }
    await this.#assertClean(repository.root);
    const integrationPath = await this.#worktreeForBranch(repository.root, integration);
    if (integrationPath !== undefined) await this.#assertClean(integrationPath);
    if (!(await this.#isAncestor(repository.root, repository.currentBranch, integration))) {
      throw codedError(
        "desktop.git-source-advanced",
        "The source branch advanced after this Run began. Review integration manually.",
      );
    }
    if (await this.#isAncestor(repository.root, integration, repository.currentBranch)) {
      if (integrationPath !== undefined) await this.#removeWorktree(repository.root, integration);
      return this.#result("already-complete", integration, integration, [], projectPath);
    }
    await this.#git(repository.root, ["merge", "--ff-only", integration]);
    if (integrationPath !== undefined) await this.#removeWorktree(repository.root, integration);
    return this.#result("integrated", integration, integration, [], projectPath);
  }

  async #result(
    disposition: "materialized" | "merged" | "integrated" | "conflict" | "already-complete",
    branch: string,
    integration: string,
    conflictPaths: readonly string[],
    projectPath: string,
  ): Promise<DesktopGitActionResultV1> {
    return DesktopGitActionResultV1Schema.parse({
      schemaVersion: 1,
      disposition,
      branch,
      integrationBranch: integration,
      conflictPaths,
      snapshot: await this.snapshot(projectPath),
    });
  }

  async #repository(projectPath: string): Promise<GitRepository> {
    const resolvedProject = path.resolve(projectPath);
    const root = path.resolve(
      (await this.#git(resolvedProject, ["rev-parse", "--show-toplevel"])).trim(),
    );
    if (!inside(root, resolvedProject)) {
      throw codedError("desktop.git-path-invalid", "The project is outside its Git repository.");
    }
    const currentBranch = (await this.#git(root, ["branch", "--show-current"])).trim();
    if (currentBranch.length === 0) {
      throw codedError("desktop.git-detached", "HoneyBee requires a named source branch.");
    }
    return {
      root,
      projectRelativePath: path.relative(root, resolvedProject),
      currentBranch,
      repositoryKey: createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 16),
    };
  }

  #ownedPath(repository: GitRepository, kind: "integration" | "work", id: string): string {
    const target = path.resolve(this.#root, repository.repositoryKey, kind, safeIdentifier(id));
    if (!inside(this.#root, target)) {
      throw codedError("desktop.git-path-invalid", "The generated worktree path is unsafe.");
    }
    return target;
  }

  async #assertClean(worktreePath: string): Promise<void> {
    const status = await this.#git(worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.trim().length > 0) {
      throw codedError(
        "desktop.git-dirty",
        "Git integration requires a clean worktree so HoneyBee never mixes user changes.",
      );
    }
  }

  async #applyPreview(projectRoot: string, patch: VerifiedPatchViewV1): Promise<void> {
    for (const file of patch.files) {
      const normalized = file.path.split(/[\\/]/u).filter(Boolean);
      if (
        path.isAbsolute(file.path) ||
        normalized.length === 0 ||
        normalized.some((segment) => segment === "." || segment === "..")
      ) {
        throw codedError("desktop.git-path-invalid", "A verified patch path is unsafe.");
      }
      const target = path.resolve(projectRoot, ...normalized);
      if (!inside(projectRoot, target)) {
        throw codedError("desktop.git-path-invalid", "A verified patch escaped the Unity project.");
      }
      await this.#assertNoSymlink(projectRoot, normalized.slice(0, -1));
      const current = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (file.operation === "add") {
        if (current !== undefined)
          throw codedError("desktop.git-patch-conflict", "An added file already exists.");
      } else if (current === undefined || contentDigest(current) !== file.before?.contentDigest) {
        throw codedError(
          "desktop.git-patch-conflict",
          "The worktree does not match the patch base.",
        );
      }
      if (file.operation === "delete") {
        await unlink(target);
        continue;
      }
      const after = file.after;
      if (
        after?.format !== "text" ||
        after.text === undefined ||
        after.truncated ||
        contentDigest(Buffer.from(after.text, "utf8")) !== after.contentDigest
      ) {
        throw codedError(
          "desktop.git-patch-preview-incomplete",
          "This patch contains binary or truncated files and cannot be materialized from its preview.",
        );
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.honeybee-${process.pid}-${Date.now()}.tmp`;
      await writeFile(temporary, after.text, { encoding: "utf8", flag: "wx" });
      if (current === undefined) {
        await rename(temporary, target);
      } else {
        const backup = `${temporary}.backup`;
        await rename(target, backup);
        try {
          await rename(temporary, target);
          await unlink(backup);
        } catch (error) {
          await rename(backup, target).catch(() => undefined);
          throw error;
        }
      }
    }
  }

  async #assertNoSymlink(root: string, segments: readonly string[]): Promise<void> {
    let cursor = root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat?.isSymbolicLink() === true) {
        throw codedError("desktop.git-path-invalid", "Patch symlink traversal is forbidden.");
      }
    }
  }

  async #branchExists(root: string, branch: string): Promise<boolean> {
    try {
      await this.#git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async #worktreeForBranch(root: string, branch: string): Promise<string | undefined> {
    return this.#parseWorktrees(await this.#git(root, ["worktree", "list", "--porcelain"])).find(
      (worktree) => worktree.branch === branch,
    )?.path;
  }

  async #removeWorktree(root: string, branch: string): Promise<void> {
    const worktreePath = await this.#worktreeForBranch(root, branch);
    if (worktreePath === undefined) return;
    if (!inside(this.#root, path.resolve(worktreePath))) {
      throw codedError(
        "desktop.git-path-invalid",
        "HoneyBee refuses to remove an unowned worktree.",
      );
    }
    await this.#git(root, ["worktree", "remove", worktreePath]);
  }

  async #isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.#git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  #parseWorktrees(value: string): ParsedWorktree[] {
    return value
      .trim()
      .split(/\r?\n\r?\n/u)
      .map((block) => {
        const fields = Object.fromEntries(
          block.split(/\r?\n/u).map((line) => {
            const separator = line.indexOf(" ");
            return separator < 0
              ? [line, ""]
              : [line.slice(0, separator), line.slice(separator + 1)];
          }),
        );
        return {
          path: fields.worktree ?? "",
          head: fields.HEAD ?? "",
          branch: (fields.branch ?? "detached").replace(/^refs\/heads\//u, ""),
        };
      })
      .filter((worktree) => worktree.path.length > 0 && /^[0-9a-f]{40,64}$/u.test(worktree.head));
  }

  async #git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFileAsync("git.exe", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      encoding: "utf8",
    });
    return result.stdout;
  }
}
