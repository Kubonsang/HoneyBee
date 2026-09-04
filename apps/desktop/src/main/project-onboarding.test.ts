import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cloneUnityProject,
  discoverProjectCandidates,
  readUnityHubProjects,
} from "./project-onboarding.js";

describe("Desktop project onboarding", () => {
  it("reads Unity Hub projects and deduplicates registered paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-hub-"));
    const project = path.join(root, "Game");
    await Promise.all(
      ["Assets", "Packages", "ProjectSettings"].map((entry) =>
        mkdir(path.join(project, entry), { recursive: true }),
      ),
    );
    const hub = path.join(root, "projects-v1.json");
    await writeFile(
      hub,
      JSON.stringify({
        schema_version: "v1",
        data: { [project]: { title: "Hub Game", path: project, version: "6000.0.42f1" } },
      }),
      "utf8",
    );
    expect(await readUnityHubProjects(hub)).toHaveLength(1);
    const candidates = await discoverProjectCandidates(
      [
        {
          schemaVersion: 2,
          projectId: "registered",
          label: "Registered Game",
          unityProjectPath: project,
          repositoryRoot: project,
          unityRelativePath: "",
          workspaceRoot: path.join(root, "workspaces"),
          storageCommand: process.execPath,
          createdAt: new Date(0).toISOString(),
        },
      ],
      hub,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "honeybee",
      registeredProjectId: "registered",
      setupState: "ready",
    });
  });

  it("treats a missing or malformed Hub file as best-effort discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-hub-bad-"));
    expect(await discoverProjectCandidates([], path.join(root, "missing.json"))).toEqual([]);
    const malformed = path.join(root, "malformed.json");
    await writeFile(malformed, "not json", "utf8");
    expect(await discoverProjectCandidates([], malformed)).toEqual([]);
  });

  it("invokes git clone without a shell and preserves partial output on failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-clone-"));
    const destination = path.join(root, "Game");
    await expect(
      cloneUnityProject(
        "https://github.com/example/game.git",
        destination,
        async (command, args, options) => {
          expect(command).toBe("git.exe");
          expect(args).toEqual(["clone", "--", "https://github.com/example/game.git", destination]);
          expect(options.shell).toBe(false);
          await mkdir(destination);
          await writeFile(path.join(destination, "partial.txt"), "preserve", "utf8");
          throw new Error("network failed");
        },
      ),
    ).rejects.toMatchObject({ code: "git.clone-failed" });
    expect(await readFile(path.join(destination, "partial.txt"), "utf8")).toBe("preserve");
  });

  it("rejects an existing destination before invoking Git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-clone-existing-"));
    let invoked = false;
    await expect(
      cloneUnityProject("git@github.com:example/game.git", root, async () => {
        invoked = true;
      }),
    ).rejects.toMatchObject({ code: "project.clone-destination-exists" });
    expect(invoked).toBe(false);
  });

  it("rejects a relative clone destination", async () => {
    await expect(
      cloneUnityProject("https://github.com/example/game.git", "relative-game"),
    ).rejects.toMatchObject({ code: "project.clone-destination-invalid" });
  });
});
