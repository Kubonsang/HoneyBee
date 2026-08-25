import type { Stats } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export class UnsafeImmutablePublicationError extends Error {}

/**
 * Recovers the only expected hard-link publication crash window:
 * final and private temporary names referring to the same inode.
 */
export const recoverImmutablePublication = async (
  finalPath: string,
  isTemporaryName: (name: string) => boolean,
): Promise<Stats> => {
  const initial = await lstat(finalPath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink <= 1) return initial;

  const directory = path.dirname(finalPath);
  const matchingTemporaryPaths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!isTemporaryName(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
    const temporaryPath = path.join(directory, entry.name);
    const metadata = await lstat(temporaryPath);
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.dev === initial.dev &&
      metadata.ino === initial.ino
    ) {
      matchingTemporaryPaths.push(temporaryPath);
    }
  }

  if (initial.nlink !== matchingTemporaryPaths.length + 1) {
    throw new UnsafeImmutablePublicationError(
      "The immutable publication has an unrecognized hard link.",
    );
  }

  for (const temporaryPath of matchingTemporaryPaths) {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }

  const recovered = await lstat(finalPath);
  if (
    !recovered.isFile() ||
    recovered.isSymbolicLink() ||
    recovered.dev !== initial.dev ||
    recovered.ino !== initial.ino ||
    recovered.nlink !== 1
  ) {
    throw new UnsafeImmutablePublicationError(
      "The immutable publication changed while recovering its temporary link.",
    );
  }
  return recovered;
};
