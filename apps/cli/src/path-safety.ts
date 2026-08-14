import { realpath } from "node:fs/promises";
import path from "node:path";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const comparablePath = (value: string): string => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

export const pathsOverlap = (left: string, right: string): boolean => {
  const comparableLeft = comparablePath(left);
  const comparableRight = comparablePath(right);
  const relativeLeft = path.relative(comparableLeft, comparableRight);
  const relativeRight = path.relative(comparableRight, comparableLeft);
  return (
    relativeLeft === "" ||
    (!relativeLeft.startsWith(".." + path.sep) &&
      relativeLeft !== ".." &&
      !path.isAbsolute(relativeLeft)) ||
    (!relativeRight.startsWith(".." + path.sep) &&
      relativeRight !== ".." &&
      !path.isAbsolute(relativeRight))
  );
};

export const samePath = (left: string, right: string): boolean =>
  comparablePath(path.resolve(left)) === comparablePath(path.resolve(right));

export const physicalPath = async (value: string): Promise<string> => {
  let existing = path.resolve(value);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(existing);
      return path.resolve(resolved, ...missingSegments.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missingSegments.push(path.basename(existing));
      existing = parent;
    }
  }
};

export const physicalPathsOverlap = async (left: string, right: string): Promise<boolean> => {
  const [physicalLeft, physicalRight] = await Promise.all([
    physicalPath(left),
    physicalPath(right),
  ]);
  return pathsOverlap(physicalLeft, physicalRight);
};
