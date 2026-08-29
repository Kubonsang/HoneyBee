import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UnityProjectBootstrap } from "./unity-adapters.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-agent-context-"));
  roots.push(root);
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  for (const directory of ["Assets", "Packages", "ProjectSettings", ".agents/skills/sample"]) {
    await mkdir(path.join(source, directory), { recursive: true });
  }
  await mkdir(workspace);
  await writeFile(path.join(source, "Assets", "Example.cs"), "class Example {}\n");
  await writeFile(path.join(source, "Packages", "manifest.json"), "{}\n");
  await writeFile(
    path.join(source, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: x\n",
  );
  await writeFile(path.join(source, "AGENTS.md"), "# Project instructions\n");
  await writeFile(path.join(source, ".agents", "skills", "sample", "SKILL.md"), "# Sample\n");
  return { source, workspace };
};

describe("Agent context materialization", () => {
  it("copies verified context while Unity source manifests remain Assets-only", async () => {
    const { source, workspace } = await fixture();
    const bootstrap = new UnityProjectBootstrap();
    const before = await bootstrap.manifest(source);
    const files = await bootstrap.materializeAgentContext(source, workspace);
    await writeFile(path.join(source, "AGENTS.md"), "# Changed instructions\n");
    const after = await bootstrap.manifest(source);
    expect(after).toEqual(before);
    expect(files.map((file) => file.logicalPath)).toEqual([
      ".agents/skills/sample/SKILL.md",
      "AGENTS.md",
    ]);
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.toContain(
      "Project instructions",
    );
  });

  it("rejects hard-linked context files", async () => {
    const { source, workspace } = await fixture();
    const shared = path.join(source, "shared.md");
    await writeFile(shared, "shared\n");
    const target = path.join(source, ".agents", "skills", "sample", "linked.md");
    await link(shared, target);
    await expect(
      new UnityProjectBootstrap().materializeAgentContext(source, workspace),
    ).rejects.toThrow("private");
  });
});
