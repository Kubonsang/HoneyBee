import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { VerifiedPatchViewV1Schema } from "@honeybee/control-plane-contracts";
import { describe, expect, it } from "vitest";

import { DesktopGitWorktrees } from "./git-worktrees.js";

const execFileAsync = promisify(execFile);
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await execFileAsync("git.exe", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    })
  ).stdout;

describe("DesktopGitWorktrees", () => {
  it("commits a verified text patch to a Work branch and merges it into integration", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "honeybee-git-source-"));
    const userData = await mkdtemp(path.join(tmpdir(), "honeybee-git-data-"));
    await mkdir(path.join(repository, "Assets"), { recursive: true });
    const before = "public class Player {}\n";
    const after = "public class Player { public int Level = 1; }\n";
    await writeFile(path.join(repository, "Assets", "Player.cs"), before, "utf8");
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "core.autocrlf", "false");
    await git(repository, "add", ".");
    await git(
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    );
    await git(repository, "config", "user.name", "");
    await git(repository, "config", "user.email", "");
    const repositoryAlias = path.join(userData, "source-alias");
    await symlink(repository, repositoryAlias, process.platform === "win32" ? "junction" : "dir");
    const runId = "11111111-1111-4111-8111-111111111111";
    const groupRunId = "22222222-2222-4222-8222-222222222222";
    const patch = VerifiedPatchViewV1Schema.parse({
      schemaVersion: 1,
      runId,
      patch: {
        artifactId: "33333333-3333-4333-8333-333333333333",
        kind: "unity-verified-patch",
        mediaType: "application/vnd.honeybee.unity-patch+json",
        byteLength: 128,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
      manifestVersion: 3,
      verification: { workspaceIntegrity: "verified", compile: "passed", warmTest: "not-run" },
      sourceProjectPath: repositoryAlias,
      sourceState: "clean",
      disposition: "pending",
      conflictPaths: [],
      files: [
        {
          path: "Assets/Player.cs",
          operation: "modify",
          before: {
            contentDigest: digest(before),
            byteLength: Buffer.byteLength(before),
            format: "text",
            text: before,
            truncated: false,
          },
          after: {
            contentDigest: digest(after),
            byteLength: Buffer.byteLength(after),
            format: "text",
            text: after,
            truncated: false,
          },
        },
      ],
      allowedActions: ["apply", "reject"],
    });
    const worktrees = new DesktopGitWorktrees(userData);

    const materialized = await worktrees.materialize(repositoryAlias, runId, groupRunId, patch);
    expect(materialized.disposition).toBe("materialized");
    expect(materialized.snapshot.worktrees.some((entry) => entry.kind === "work")).toBe(true);

    const merged = await worktrees.merge(repositoryAlias, runId, groupRunId);
    expect(merged.disposition).toBe("merged");
    expect(merged.snapshot.worktrees.some((entry) => entry.kind === "work")).toBe(false);
    const integration = merged.snapshot.worktrees.find((entry) => entry.kind === "integration");
    expect(integration).toBeDefined();
    expect(await readFile(path.join(integration?.path ?? "", "Assets", "Player.cs"), "utf8")).toBe(
      after,
    );
    expect(await git(repository, "branch", "--list", `honeybee/work/${runId}`)).toContain(runId);
    expect(await readFile(path.join(repository, "Assets", "Player.cs"), "utf8")).toBe(before);

    const integrated = await worktrees.finalize(repositoryAlias, groupRunId);
    expect(integrated.disposition).toBe("integrated");
    expect(integrated.snapshot.worktrees.some((entry) => entry.kind === "integration")).toBe(false);
    expect(await readFile(path.join(repository, "Assets", "Player.cs"), "utf8")).toBe(after);
    expect(
      await git(repository, "branch", "--list", `honeybee/integration/${groupRunId}`),
    ).toContain(groupRunId);
  }, 15_000);
});
