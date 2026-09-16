import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readBounded } from "../update/prepare-release.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";

/** Read-only QA guard: a never-created registry is empty, not a reason to create one. */
export const readEmptyQARegistry = async (file) => {
  let parent = path.dirname(path.resolve(file));
  for (;;) {
    try {
      await lstat(parent);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(parent) === parent) throw error;
      parent = path.dirname(parent);
    }
  }
  await plainDirectory(parent);
  let bytes;
  try {
    bytes = await readBounded(file, 8 * 1024 * 1024);
  } catch (error) {
    if (error.code === "ENOENT") return { digest: null };
    throw error;
  }
  const state = JSON.parse(bytes);
  assert(
    state.schemaVersion === 2 && Array.isArray(state.projects) && Array.isArray(state.workspaces),
    "Invalid QA registry",
  );
  assert.equal(state.projects.length, 0, "QA requires no registered projects");
  assert.equal(state.workspaces.length, 0, "QA requires no workspaces");
  return { digest: sha256(bytes) };
};
