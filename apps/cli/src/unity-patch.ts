import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ContentDigestSchema,
  UnityPatchManifestV1Schema,
  type ArtifactKind,
  type ArtifactMediaType,
  type ArtifactRef,
  type ContentDigest,
  type RunId,
  type UnityPatchManifestV1,
} from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError, type ArtifactStore } from "@honeybee/core";

import type { UnityProjectBootstrap } from "./unity-adapters.js";

const PROJECT_DIRECTORIES = ["Assets", "Packages", "ProjectSettings"] as const;
const MAX_PATCH_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_TOTAL_BYTES = 64 * 1024 * 1024;

interface SnapshotFile {
  readonly path: string;
  readonly byteLength: number;
  readonly contentDigest: ContentDigest;
}

export interface UnityWorkspaceManifest {
  readonly schemaVersion: 1;
  readonly digest: ContentDigest;
  readonly fileCount: number;
  readonly logicalBytes: number;
  readonly files: readonly SnapshotFile[];
}

export interface VerifiedUnityPatch {
  readonly patch: ArtifactRef;
  readonly resultManifest: ArtifactRef;
}

type PublishBytes = (
  kind: ArtifactKind,
  mediaType: ArtifactMediaType,
  content: Uint8Array,
) => Promise<ArtifactRef>;
type PublishJson = (kind: ArtifactKind, value: unknown) => Promise<ArtifactRef>;

const digest = (bytes: Uint8Array): ContentDigest =>
  ContentDigestSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);

const digestFile = async (
  filePath: string,
  treeHash?: ReturnType<typeof createHash>,
): Promise<Readonly<{ byteLength: number; contentDigest: ContentDigest }>> => {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new HoneyBeeCoreError("workspace.invalid-project", "Patch tree file is not private.");
  }
  const fileHash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    fileHash.update(bytes);
    treeHash?.update(bytes);
  }
  const after = await lstat(filePath);
  if (
    byteLength !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1
  ) {
    throw new HoneyBeeCoreError("artifact.integrity-failed", "Patch tree changed while hashing.");
  }
  return {
    byteLength,
    contentDigest: ContentDigestSchema.parse(`sha256:${fileHash.digest("hex")}`),
  };
};

const pathOrder = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const unsafeWindowsPathSegment = (segment: string): boolean =>
  /[<>:"|?*]/u.test(segment) ||
  [...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20);

const safeRelative = (relative: string): readonly string[] => {
  const segments = relative.split("/");
  if (
    relative.length === 0 ||
    relative.includes("\\") ||
    path.isAbsolute(relative) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        unsafeWindowsPathSegment(segment) ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    ) ||
    !PROJECT_DIRECTORIES.includes(segments[0] as (typeof PROJECT_DIRECTORIES)[number])
  ) {
    throw new HoneyBeeCoreError(
      "workspace.invalid-project",
      "Patch path escaped the Unity project.",
    );
  }
  return segments;
};

const filesUnder = async (root: string): Promise<readonly string[]> => {
  const files: string[] = [];
  const caseInsensitive = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "Patch tree contains a reparse directory.",
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => pathOrder(left.name, right.name));
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      const child = await lstat(absolute);
      if (child.isSymbolicLink()) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Patch tree contains a reparse entry.",
        );
      }
      if (child.isDirectory()) await visit(absolute, relative);
      else if (child.isFile()) {
        if (child.nlink !== 1) {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Patch tree contains a hard-linked file.",
          );
        }
        const folded = relative.toLocaleLowerCase("en-US");
        if (caseInsensitive.has(folded)) {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Patch paths collide case-insensitively.",
          );
        }
        caseInsensitive.add(folded);
        files.push(relative);
      } else {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Patch tree contains an unsupported entry.",
        );
      }
    }
  };
  for (const directory of PROJECT_DIRECTORIES) {
    await visit(path.join(root, directory), directory);
  }
  return files.sort(pathOrder);
};

const snapshot = async (root: string): Promise<UnityWorkspaceManifest> => {
  const hash = createHash("sha256");
  hash.update("honeybee-unity-workspace-manifest-v1\0", "utf8");
  const files: SnapshotFile[] = [];
  let logicalBytes = 0;
  for (const relative of await filesUnder(root)) {
    const target = path.join(root, ...safeRelative(relative));
    const metadata = await lstat(target);
    const relativeBytes = Buffer.from(relative, "utf8");
    const relativeLength = Buffer.allocUnsafe(8);
    relativeLength.writeBigUInt64BE(BigInt(relativeBytes.byteLength));
    const contentLength = Buffer.allocUnsafe(8);
    contentLength.writeBigUInt64BE(BigInt(metadata.size));
    hash.update(relativeLength);
    hash.update(relativeBytes);
    hash.update(contentLength);
    const content = await digestFile(target, hash);
    files.push({ path: relative, ...content });
    logicalBytes += content.byteLength;
  }
  return {
    schemaVersion: 1,
    digest: ContentDigestSchema.parse(`sha256:${hash.digest("hex")}`),
    fileCount: files.length,
    logicalBytes,
    files,
  };
};

const sameSnapshot = (left: UnityWorkspaceManifest, right: UnityWorkspaceManifest): boolean =>
  left.digest === right.digest &&
  left.fileCount === right.fileCount &&
  left.logicalBytes === right.logicalBytes;

const applyManifest = async (
  runId: RunId,
  root: string,
  artifacts: ArtifactStore,
  manifest: UnityPatchManifestV1,
): Promise<void> => {
  for (const entry of manifest.entries) {
    const target = path.join(root, ...safeRelative(entry.path));
    if (entry.operation === "delete") {
      const before = await digestFile(target);
      if (before.contentDigest !== entry.baseContentDigest) {
        throw new HoneyBeeCoreError(
          "artifact.integrity-failed",
          "Patch deletion base did not match.",
        );
      }
      await unlink(target);
      continue;
    }
    const content = await artifacts.getBytes({ runId, artifact: entry.content });
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const current = await lstat(target);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Patch target is not a private file.",
        );
      }
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(target, content, { flag: "w" });
  }
};

export class UnityPatchBuilder {
  public constructor(
    private readonly artifacts: ArtifactStore,
    private readonly bootstrap: UnityProjectBootstrap,
    private readonly scratchRoot: string,
  ) {}

  public async build(
    input: Readonly<{
      runId: RunId;
      sourceProjectPath: string;
      workspacePath: string;
      baseManifest: ArtifactRef;
      verifySource: () => Promise<void>;
      publishBytes: PublishBytes;
      publishJson: PublishJson;
    }>,
  ): Promise<VerifiedUnityPatch> {
    await input.verifySource();
    const workspaceResult = await snapshot(input.workspacePath);
    const resultManifest = await input.publishJson("unity-workspace-manifest", workspaceResult);
    await mkdir(this.scratchRoot, { recursive: true });
    const temporary = await mkdtemp(path.join(this.scratchRoot, "patch-verify-"));
    const verificationId = "source";
    const verificationRoot = path.join(temporary, verificationId);
    try {
      await this.bootstrap.prepare(input.sourceProjectPath, temporary, verificationId);
      const sourceSnapshot = await snapshot(verificationRoot);
      const sourceByPath = new Map(sourceSnapshot.files.map((file) => [file.path, file]));
      const resultByPath = new Map(workspaceResult.files.map((file) => [file.path, file]));
      const paths = [...new Set([...sourceByPath.keys(), ...resultByPath.keys()])].sort(pathOrder);
      const entries: UnityPatchManifestV1["entries"][number][] = [];
      let patchBytes = 0;
      for (const relative of paths) {
        const before = sourceByPath.get(relative);
        const after = resultByPath.get(relative);
        if (after === undefined) {
          if (before === undefined) throw new Error("unreachable");
          entries.push({
            path: relative,
            operation: "delete",
            baseContentDigest: before.contentDigest,
          });
          continue;
        }
        if (before?.contentDigest === after.contentDigest) continue;
        if (after.byteLength > MAX_PATCH_FILE_BYTES) {
          throw new HoneyBeeCoreError("patch.too-large", "Patch file exceeded 16 MiB.");
        }
        patchBytes += after.byteLength;
        if (patchBytes > MAX_PATCH_TOTAL_BYTES) {
          throw new HoneyBeeCoreError("patch.too-large", "Patch content exceeded 64 MiB.");
        }
        const content = await readFile(path.join(input.workspacePath, ...safeRelative(relative)));
        if (digest(content) !== after.contentDigest) {
          throw new HoneyBeeCoreError(
            "artifact.integrity-failed",
            "Workspace changed during patch capture.",
          );
        }
        const artifact = await input.publishBytes(
          "unity-patch-content",
          "application/octet-stream",
          content,
        );
        entries.push({ path: relative, operation: "add-or-modify", content: artifact });
      }
      const manifest = UnityPatchManifestV1Schema.parse({
        schemaVersion: 1,
        baseManifest: input.baseManifest,
        resultManifest,
        entries,
      });
      const patch = await input.publishJson("unity-verified-patch", manifest);
      const stored = UnityPatchManifestV1Schema.parse(
        JSON.parse(await this.artifacts.get({ runId: input.runId, artifact: patch })) as unknown,
      );
      await applyManifest(input.runId, verificationRoot, this.artifacts, stored);
      const applied = await snapshot(verificationRoot);
      if (!sameSnapshot(applied, workspaceResult)) {
        throw new HoneyBeeCoreError(
          "patch.verification-failed",
          "Published patch did not recreate the workspace result.",
        );
      }
      await input.verifySource();
      return { patch, resultManifest };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
