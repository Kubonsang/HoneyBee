/** Decode Git's C-quoted porcelain paths without depending on Node in the renderer. */
const decodePath = (value: string): string => {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("Invalid quoted Git path.");
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  const contents = value.slice(1, -1);
  for (let index = 0; index < contents.length;) {
    const character = contents[index];
    if (character === "\\") {
      const octal = /^[0-7]{3}/u.exec(contents.slice(index + 1));
      if (octal !== null) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += 4;
        continue;
      }
      const escaped = escapes[contents[index + 1] ?? ""];
      if (escaped === undefined) throw new Error("Invalid Git path escape.");
      bytes.push(...encoder.encode(escaped));
      index += 2;
    } else {
      const point = contents.codePointAt(index);
      if (point === undefined) break;
      const text = String.fromCodePoint(point);
      bytes.push(...encoder.encode(text));
      index += text.length;
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
};

export const parseGitStatusLine = (line: string) => {
  const status = line.slice(0, 2);
  const value = line.slice(3);
  if (status.includes("R") || status.includes("C")) {
    const match = /^("(?:\\.|[^"\\])*"|.*?) -> (.*)$/u.exec(value);
    if (match?.[1] === undefined || match[2] === undefined)
      throw new Error("Invalid Git rename record.");
    return {
      status,
      path: decodePath(match[2]),
      originalPath: decodePath(match[1]),
      untracked: false,
    };
  }
  return { status, path: decodePath(value), untracked: status === "??" };
};
