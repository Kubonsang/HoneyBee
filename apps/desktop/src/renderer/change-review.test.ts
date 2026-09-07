import { expect, it } from "vitest";
import { changeGroup, diffLines } from "./change-review.js";

it("groups file types without guessing who changed their contents", () => {
  expect(changeGroup("ProjectSettings/ShaderGraphSettings.asset")).toBe("unitySettingsFiles");
  expect(changeGroup("Game/Packages/packages-lock.json")).toBe("unitySettingsFiles");
  expect(changeGroup("Assets/Player.cs.meta")).toBe("metadataFiles");
  expect(changeGroup("Assets/Player.prefab")).toBe("contentFiles");
  expect(changeGroup("README.md")).toBe("otherFiles");
});

it("numbers added, deleted and context lines across files and hunks", () => {
  const lines = diffLines(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -4,2 +8,2 @@\n-old\n+new\n same\n\\ No newline at end of file\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1,1 @@\n+created\n",
  );
  expect(lines[2]).toMatchObject({ kind: "heading" });
  expect(lines[4]).toMatchObject({ kind: "removed", oldLine: 4 });
  expect(lines[5]).toMatchObject({ kind: "added", newLine: 8 });
  expect(lines[6]).toMatchObject({ kind: "context", oldLine: 5, newLine: 9 });
  expect(lines.at(-1)).toMatchObject({ kind: "added", newLine: 1 });
  expect(diffLines("@@ not a patch\n+literal\n", true)).toEqual([
    { text: "@@ not a patch", kind: "added", newLine: 1 },
    { text: "+literal", kind: "added", newLine: 2 },
  ]);
});
