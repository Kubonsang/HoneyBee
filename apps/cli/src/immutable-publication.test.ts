import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readRecoveredImmutableFile,
  UnsafeImmutablePublicationError,
} from "./immutable-publication.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const root = async (): Promise<string> => {
  const value = await mkdtemp(path.join(tmpdir(), "honeybee-immutable-"));
  roots.push(value);
  return value;
};

describe("readRecoveredImmutableFile", () => {
  it("recovers the recognized publisher hard link and reads the verified inode", async () => {
    const directory = await root();
    const temporary = path.join(directory, ".00000000-0000-4000-8000-000000000001.tmp");
    const finalPath = path.join(directory, "record.json");
    await writeFile(temporary, '{"ok":true}', "utf8");
    await link(temporary, finalPath);

    const result = await readRecoveredImmutableFile(
      finalPath,
      (name) => /^\.[0-9a-f-]{36}\.tmp$/iu.test(name),
      1024,
    );

    expect(result.bytes.toString("utf8")).toBe('{"ok":true}');
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.metadata.nlink).toBe(1);
  });

  it("rejects unknown hard links and oversized records", async () => {
    const directory = await root();
    const finalPath = path.join(directory, "record.json");
    await writeFile(finalPath, "payload", "utf8");
    await link(finalPath, path.join(directory, "unknown.link"));
    await expect(readRecoveredImmutableFile(finalPath, () => false, 1024)).rejects.toBeInstanceOf(
      UnsafeImmutablePublicationError,
    );

    const bounded = path.join(directory, "bounded.json");
    await writeFile(bounded, "12345", "utf8");
    await expect(readRecoveredImmutableFile(bounded, () => false, 4)).rejects.toBeInstanceOf(
      UnsafeImmutablePublicationError,
    );
  });
});
