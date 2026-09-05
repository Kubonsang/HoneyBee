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
      const octal = contents.slice(index + 1, index + 4);
      if (/^[0-7]{3}$/u.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
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
  if (line.includes("\n") || line.includes("\r"))
    throw new Error("Git status records must not contain raw line breaks.");
  const status = line.slice(0, 2);
  const value = line.slice(3);
  if (status.includes("R") || status.includes("C")) {
    let separator = -1;
    if (value.startsWith('"')) {
      // Scan the quoted source once; escaped quotes and arrows belong to its path.
      for (let index = 1; index < value.length; index++) {
        if (value[index] === "\\") index++;
        else if (value[index] === '"') {
          if (value.startsWith(" -> ", index + 1)) separator = index + 1;
          break;
        }
      }
    } else separator = value.indexOf(" -> ");
    if (separator <= 0 || separator + 4 >= value.length)
      throw new Error("Invalid Git rename record.");
    return {
      status,
      path: decodePath(value.slice(separator + 4)),
      originalPath: decodePath(value.slice(0, separator)),
      untracked: false,
    };
  }
  return { status, path: decodePath(value), untracked: status === "??" };
};
