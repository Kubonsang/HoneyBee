import { describe, expect, it } from "vitest";
import { parseGitStatusLine } from "./git-status.js";

describe("Git porcelain paths", () => {
  it("preserves status columns, spaces, Unicode, and literal rename separators", () => {
    expect(parseGitStatusLine(" M Assets/Player.cs")).toMatchObject({
      status: " M",
      path: "Assets/Player.cs",
    });
    expect(parseGitStatusLine('?? "Assets/new file.cs"')).toMatchObject({
      path: "Assets/new file.cs",
      untracked: true,
    });
    expect(parseGitStatusLine(' M "Assets/\\355\\225\\234\\352\\270\\200.cs"').path).toBe(
      "Assets/한글.cs",
    );
    expect(parseGitStatusLine(' M "Assets/a -> b.cs"').path).toBe("Assets/a -> b.cs");
    expect(parseGitStatusLine(' M "Assets/a\\"b\\tc.cs"').path).toBe('Assets/a"b\tc.cs');
  });
  it("separates quoted rename paths without interpreting their contents", () => {
    expect(parseGitStatusLine('R  "Assets/a -> b.cs" -> "Assets/새 파일.cs"')).toMatchObject({
      originalPath: "Assets/a -> b.cs",
      path: "Assets/새 파일.cs",
      status: "R ",
    });
    expect(parseGitStatusLine('R  "Assets/a\\" -> b.cs" -> target.cs')).toMatchObject({
      originalPath: 'Assets/a" -> b.cs',
      path: "target.cs",
    });
  });
  it("handles repeated separators and rejects unterminated quoted sources in one scan", () => {
    const repeated = " -> a".repeat(50_000);
    expect(parseGitStatusLine(`R  source -> ${repeated}`).path).toBe(repeated);
    expect(() => parseGitStatusLine(`R  "${repeated}`)).toThrow("Invalid Git rename record");
    expect(() => parseGitStatusLine(`R  ${repeated}\n`)).toThrow("raw line breaks");
    expect(() => parseGitStatusLine('R  "source"missing -> target')).toThrow(
      "Invalid Git rename record",
    );
  });
});
