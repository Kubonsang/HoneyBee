export type ChangeGroup = "contentFiles" | "unitySettingsFiles" | "metadataFiles" | "otherFiles";
export const changeGroups: readonly ChangeGroup[] = [
  "contentFiles",
  "unitySettingsFiles",
  "metadataFiles",
  "otherFiles",
];
export function changeGroup(file: string): ChangeGroup {
  const normalized = file.replaceAll("\\", "/");
  if (/\.meta$/iu.test(normalized)) return "metadataFiles";
  if (/(^|\/)(ProjectSettings|UserSettings|Packages)\//iu.test(normalized))
    return "unitySettingsFiles";
  if (
    /(^|\/)Assets\//iu.test(normalized) ||
    /\.(cs|shader|hlsl|cginc|uxml|uss|js|ts|tsx|json)$/iu.test(normalized)
  )
    return "contentFiles";
  return "otherFiles";
}
export interface DiffLine {
  text: string;
  kind: "context" | "added" | "removed" | "heading";
  oldLine?: number;
  newLine?: number;
}
export function diffLines(content: string, untracked = false): DiffLine[] {
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((text, index) => {
    if (untracked) return { text: text.replace(/\r$/u, ""), kind: "added", newLine: index + 1 };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { text, kind: "heading" };
    }
    if (text.startsWith("diff --git ")) inHunk = false;
    if (inHunk && text.startsWith("+")) return { text, kind: "added", newLine: newLine++ };
    if (inHunk && text.startsWith("-")) return { text, kind: "removed", oldLine: oldLine++ };
    if (inHunk && text.startsWith(" "))
      return { text, kind: "context", oldLine: oldLine++, newLine: newLine++ };
    return { text, kind: "heading" };
  });
}
