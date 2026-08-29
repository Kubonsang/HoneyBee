export type DiffLineKind = "context" | "remove" | "add";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine?: number | undefined;
  readonly newLine?: number | undefined;
}

const MAX_LCS_LINES = 700;

export const buildLineDiff = (beforeValue: string, afterValue: string): readonly DiffLine[] => {
  const before = beforeValue.split("\n");
  const after = afterValue.split("\n");
  if (before.length + after.length > MAX_LCS_LINES) {
    return [
      ...before.map((text, index) => ({
        kind: "remove" as const,
        text,
        oldLine: index + 1,
      })),
      ...after.map((text, index) => ({
        kind: "add" as const,
        text,
        newLine: index + 1,
      })),
    ];
  }

  const rows = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  const scoreAt = (row: number, column: number): number => rows[row]?.[column] ?? 0;
  for (let left = before.length - 1; left >= 0; left -= 1) {
    const row = rows[left];
    if (!row) {
      continue;
    }
    for (let right = after.length - 1; right >= 0; right -= 1) {
      row[right] =
        before[left] === after[right]
          ? scoreAt(left + 1, right + 1) + 1
          : Math.max(scoreAt(left + 1, right), scoreAt(left, right + 1));
    }
  }

  const result: DiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      result.push({
        kind: "context",
        text: before[left] ?? "",
        oldLine: left + 1,
        newLine: right + 1,
      });
      left += 1;
      right += 1;
    } else if (scoreAt(left + 1, right) >= scoreAt(left, right + 1)) {
      result.push({ kind: "remove", text: before[left] ?? "", oldLine: left + 1 });
      left += 1;
    } else {
      result.push({ kind: "add", text: after[right] ?? "", newLine: right + 1 });
      right += 1;
    }
  }
  while (left < before.length) {
    result.push({ kind: "remove", text: before[left] ?? "", oldLine: left + 1 });
    left += 1;
  }
  while (right < after.length) {
    result.push({ kind: "add", text: after[right] ?? "", newLine: right + 1 });
    right += 1;
  }
  return result;
};
