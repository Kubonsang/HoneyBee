import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DesktopProjectFiles } from "./project-files.js";

describe("DesktopProjectFiles", () => {
  it("lists, searches, and reads bounded project files while hiding generated directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-project-files-"));
    await mkdir(path.join(root, "Assets", "Scripts"), { recursive: true });
    await mkdir(path.join(root, "Library"), { recursive: true });
    await writeFile(path.join(root, "Assets", "Scripts", "Player.cs"), "class Player {}\n");
    await writeFile(path.join(root, "Library", "hidden.txt"), "generated\n");
    const files = new DesktopProjectFiles();

    const tree = await files.tree(root, "");
    expect(tree.entries.map((entry) => entry.name)).toEqual(["Assets"]);
    const nested = await files.tree(root, "Assets/Scripts");
    expect(nested.entries[0]?.relativePath).toBe("Assets/Scripts/Player.cs");
    const file = await files.read(root, "Assets/Scripts/Player.cs");
    expect(file.content).toContain("class Player");
    expect(file.language).toBe("csharp");
    const search = await files.search(root, "player", 20);
    expect(search.matches.map((entry) => entry.relativePath)).toEqual(["Assets/Scripts/Player.cs"]);
  });

  it("rejects traversal and symlink reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-project-files-"));
    const outside = await mkdtemp(path.join(tmpdir(), "honeybee-project-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(outside, path.join(root, "escape"), "junction");
    const files = new DesktopProjectFiles();

    await expect(files.read(root, "../secret.txt")).rejects.toMatchObject({
      code: "desktop.project-path-invalid",
    });
    await expect(files.read(root, "escape/secret.txt")).rejects.toMatchObject({
      code: "desktop.project-symlink-forbidden",
    });
  });
});
