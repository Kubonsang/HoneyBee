import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  PatchControlResultV1Schema,
  PatchFileViewV1Schema,
  VerifiedPatchViewV1Schema,
  type PatchActionV1,
  type PatchControlResultV1,
  type PatchFileViewV1,
  type VerifiedPatchViewV1,
} from "@honeybee/control-plane-contracts";
import {
  ArtifactIdSchema,
  ContentDigestSchema,
  RunIdSchema,
  UnityPatchManifestSchema,
  type ArtifactRef,
  type ContentDigest,
  type RunId,
  type UnityPatchManifest,
} from "@honeybee/orchestration-contracts";
import {
  FileArtifactStore,
  FileRunControl,
  FileRunRepository,
  HoneyBeeCoreError,
} from "@honeybee/core";
import { z } from "zod";

import { physicalPath } from "./path-safety.js";
import { snapshotUnityWorkspace, type UnityWorkspaceManifest } from "./unity-patch.js";

const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 2 * 1024 * 1024;
const PROJECT_DIRECTORIES = ["Assets", "Packages", "ProjectSettings"] as const;

const PatchDispositionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    patchArtifactId: ArtifactIdSchema,
    actionId: z.string().uuid(),
    action: z.enum(["apply", "reject"]),
    phase: z.enum([
      "applying",
      "committing",
      "rolling-back",
      "applied",
      "rejected",
      "conflict",
      "indeterminate",
    ]),
    nextEntry: z.number().int().nonnegative(),
    conflictPaths: z.array(z.string().min(1).max(4096)),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
type PatchDispositionRecord = z.infer<typeof PatchDispositionRecordSchema>;

const StoredTreeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    digest: ContentDigestSchema,
    fileCount: z.number().int().nonnegative(),
    logicalBytes: z.number().int().nonnegative(),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          byteLength: z.number().int().nonnegative(),
          contentDigest: ContentDigestSchema,
        })
        .strict(),
    ),
  })
  .strict();

const unsafeWindowsPathSegment = (segment: string): boolean =>
  /[<>:"|?*]/u.test(segment) ||
  [...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20);

const safeSegments = (relative: string): readonly string[] => {
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
    throw new HoneyBeeCoreError("workspace.invalid-project", "Patch path escaped the project.");
  }
  return segments;
};

const sameTree = (left: UnityWorkspaceManifest, right: UnityWorkspaceManifest): boolean =>
  left.digest === right.digest &&
  left.fileCount === right.fileCount &&
  left.logicalBytes === right.logicalBytes;

const fileDigest = async (
  filePath: string,
): Promise<Readonly<{ byteLength: number; contentDigest: ContentDigest }> | undefined> => {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new HoneyBeeCoreError("workspace.invalid-project", "Patch target is not a private file.");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  const after = await lstat(filePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    byteLength !== before.size
  ) {
    throw new HoneyBeeCoreError("artifact.integrity-failed", "Patch target changed while reading.");
  }
  return {
    byteLength,
    contentDigest: ContentDigestSchema.parse("sha256:" + hash.digest("hex")),
  };
};

const artifactAfter = (entry: UnityPatchManifest["entries"][number]): ArtifactRef | undefined => {
  if (entry.operation === "delete") return undefined;
  return "content" in entry ? entry.content : entry.after;
};

const artifactBefore = (entry: UnityPatchManifest["entries"][number]): ArtifactRef | undefined =>
  "before" in entry ? entry.before : undefined;

const baseDigest = (entry: UnityPatchManifest["entries"][number]): ContentDigest | undefined =>
  entry.operation === "add" || entry.operation === "add-or-modify"
    ? undefined
    : entry.baseContentDigest;

export class FileUnityPatchControl {
  readonly #artifacts: FileArtifactStore;
  readonly #controls: FileRunControl;
  readonly #repository: FileRunRepository;

  public constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#artifacts = new FileArtifactStore(root);
    this.#controls = new FileRunControl(root);
    this.#repository = new FileRunRepository(root);
  }

  public async view(
    input: Readonly<{
      runId: string;
      patch: ArtifactRef;
      sourceProjectPath: string;
    }>,
  ): Promise<VerifiedPatchViewV1> {
    const runId = RunIdSchema.parse(input.runId);
    const sourceProjectPath = await physicalPath(input.sourceProjectPath);
    const manifest = await this.#manifest(runId, input.patch);
    const state = await this.#readState(runId, input.patch);
    const sourceState = await this.#sourceState(runId, sourceProjectPath, manifest);
    let remaining = MAX_TOTAL_PREVIEW_BYTES;
    const baseTree =
      manifest.schemaVersion === 1 ? undefined : await this.#tree(runId, manifest.baseTreeManifest);
    const resultTree = await this.#tree(runId, manifest.resultManifest);
    const baseFiles = new Map(baseTree?.files.map((file) => [file.path, file]) ?? []);
    const resultFiles = new Map(resultTree.files.map((file) => [file.path, file]));
    const files: PatchFileViewV1[] = [];
    for (const entry of manifest.entries) {
      const operation = entry.operation === "add-or-modify" ? "modify" : entry.operation;
      const beforeMetadata = baseFiles.get(entry.path);
      const afterMetadata = resultFiles.get(entry.path);
      const before = await this.#preview(runId, artifactBefore(entry), beforeMetadata, remaining);
      remaining -= before.used;
      const after = await this.#preview(runId, artifactAfter(entry), afterMetadata, remaining);
      remaining -= after.used;
      files.push(
        PatchFileViewV1Schema.parse({
          path: entry.path,
          operation,
          ...(before.value === undefined ? {} : { before: before.value }),
          ...(after.value === undefined ? {} : { after: after.value }),
        }),
      );
    }
    const disposition = state?.phase ?? "pending";
    const allowedActions: PatchActionV1[] =
      disposition === "pending"
        ? [...(sourceState === "clean" ? (["apply"] as const) : []), "reject"]
        : disposition === "applying" ||
            disposition === "committing" ||
            disposition === "rolling-back"
          ? ["apply"]
          : [];
    return VerifiedPatchViewV1Schema.parse({
      schemaVersion: 1,
      runId,
      patch: input.patch,
      manifestVersion: manifest.schemaVersion,
      verification:
        manifest.schemaVersion === 3
          ? manifest.verification
          : {
              workspaceIntegrity: "legacy-unknown",
              compile: "legacy-unknown",
              warmTest: "legacy-unknown",
            },
      sourceProjectPath,
      sourceState,
      disposition,
      conflictPaths: state?.conflictPaths ?? [],
      files,
      allowedActions,
      ...(sourceState === "drift"
        ? { message: "The Unity source no longer matches the verified patch base." }
        : sourceState === "unavailable"
          ? { message: "The Unity source could not be inspected safely." }
          : disposition === "conflict"
            ? { message: "Patch application conflicted and completed rollback." }
            : disposition === "indeterminate"
              ? { message: "Patch recovery could not prove a safe source state." }
              : {}),
    });
  }

  public async act(
    input: Readonly<{
      runId: string;
      patch: ArtifactRef;
      sourceProjectPath: string;
      action: PatchActionV1;
    }>,
  ): Promise<PatchControlResultV1> {
    const runId = RunIdSchema.parse(input.runId);
    const lease = await this.#controls.acquire(runId);
    try {
      const sourceProjectPath = await physicalPath(input.sourceProjectPath);
      const manifest = await this.#manifest(runId, input.patch);
      let state = await this.#readState(runId, input.patch);
      if (state !== undefined && state.action !== input.action) {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "A different patch disposition is already durable.",
        );
      }
      if (
        state !== undefined &&
        ["applied", "rejected", "conflict", "indeterminate"].includes(state.phase)
      ) {
        return this.#result(state);
      }
      if (input.action === "reject") {
        state = this.#newState(runId, input.patch, "reject", "rejected");
        await this.#writeState(runId, state);
        return this.#result(state);
      }
      if (state === undefined) {
        await this.#verifyPatchContent(runId, manifest);
        const sourceState = await this.#sourceState(runId, sourceProjectPath, manifest);
        if (sourceState === "unavailable") {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Unity source is temporarily unavailable for patch verification.",
          );
        }
        if (sourceState !== "clean") {
          state = this.#newState(runId, input.patch, "apply", "conflict", ["<source-manifest>"]);
          await this.#writeState(runId, state);
          return this.#result(state);
        }
        state = this.#newState(runId, input.patch, "apply", "applying");
        await this.#writeState(runId, state);
      }
      return await this.#continueApply(runId, sourceProjectPath, manifest, state);
    } finally {
      await lease.release();
    }
  }

  public async assertDeletionSafe(runIdValue: string): Promise<void> {
    const runId = RunIdSchema.parse(runIdValue);
    await this.#repository.open(runId);
    const directory = path.resolve(this.root, runId);
    let state: PatchDispositionRecord;
    try {
      state = PatchDispositionRecordSchema.parse(
        JSON.parse(
          await readFile(path.join(directory, "patch-disposition.json"), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new HoneyBeeCoreError(
        "run.cleanup-pending",
        "Patch disposition cannot be proven safe for deletion.",
      );
    }
    if (
      state.runId !== runId ||
      ["applying", "committing", "rolling-back", "indeterminate"].includes(state.phase)
    ) {
      throw new HoneyBeeCoreError(
        "run.cleanup-pending",
        "Patch application recovery must finish before deleting this Run.",
      );
    }
  }

  async #continueApply(
    runId: RunId,
    source: string,
    manifest: UnityPatchManifest,
    initial: PatchDispositionRecord,
  ): Promise<PatchControlResultV1> {
    let state = initial;
    if (state.phase === "committing") {
      await this.#cleanSidecars(source, manifest, state.actionId);
      state = await this.#update(runId, state, { phase: "applied" });
      return this.#result(state);
    }
    if (state.phase === "rolling-back") {
      return await this.#rollback(runId, source, manifest, state);
    }
    while (state.nextEntry < manifest.entries.length) {
      const entry = manifest.entries[state.nextEntry];
      if (entry === undefined) throw new Error("Patch entry missing.");
      const applied = await this.#applyEntry(runId, source, entry, state.actionId, state.nextEntry);
      if (!applied) {
        state = await this.#update(runId, state, {
          phase: "rolling-back",
          conflictPaths: [entry.path],
        });
        return await this.#rollback(runId, source, manifest, state);
      }
      state = await this.#update(runId, state, { nextEntry: state.nextEntry + 1 });
    }
    const result = await this.#tree(runId, manifest.resultManifest);
    const ignored = this.#sidecarRelatives(source, manifest, state.actionId);
    if (!sameTree(await snapshotUnityWorkspace(source, ignored), result)) {
      state = await this.#update(runId, state, {
        phase: "rolling-back",
        conflictPaths: ["<result-manifest>"],
      });
      return await this.#rollback(runId, source, manifest, state);
    }
    state = await this.#update(runId, state, { phase: "committing" });
    await this.#cleanSidecars(source, manifest, state.actionId);
    state = await this.#update(runId, state, { phase: "applied" });
    return this.#result(state);
  }

  async #applyEntry(
    runId: RunId,
    source: string,
    entry: UnityPatchManifest["entries"][number],
    actionId: string,
    index: number,
  ): Promise<boolean> {
    const target = await this.#target(source, entry.path, entry.operation !== "delete");
    const sidecars = this.#sidecars(target, actionId, index);
    const current = await fileDigest(target);
    const backup = await fileDigest(sidecars.backup);
    const expectedAfter = artifactAfter(entry);
    const expectedBase = baseDigest(entry);
    if (entry.operation === "delete") {
      if (current === undefined && backup?.contentDigest === expectedBase) return true;
      if (current?.contentDigest !== expectedBase || backup !== undefined) return false;
      await rename(target, sidecars.backup);
      return true;
    }
    if (entry.operation === "add") {
      if (current?.contentDigest === expectedAfter?.contentDigest) return true;
      if (current !== undefined || backup !== undefined) return false;
      await this.#stage(runId, expectedAfter, sidecars.temporary);
      await rename(sidecars.temporary, target);
      return true;
    }
    if (entry.operation === "add-or-modify") {
      if (backup !== undefined && current?.contentDigest === expectedAfter?.contentDigest)
        return true;
      if (backup !== undefined) return false;
      if (current === undefined) {
        await this.#stage(runId, expectedAfter, sidecars.temporary);
        await rename(sidecars.temporary, target);
        return true;
      }
      await this.#stage(runId, expectedAfter, sidecars.temporary);
      await rename(target, sidecars.backup);
      await rename(sidecars.temporary, target);
      return true;
    }
    if (
      backup?.contentDigest === expectedBase &&
      current?.contentDigest === expectedAfter?.contentDigest
    ) {
      return true;
    }
    if (backup?.contentDigest === expectedBase && current === undefined) {
      await this.#stage(runId, expectedAfter, sidecars.temporary);
      await rename(sidecars.temporary, target);
      return true;
    }
    if (current?.contentDigest !== expectedBase || backup !== undefined) return false;
    await this.#stage(runId, expectedAfter, sidecars.temporary);
    await rename(target, sidecars.backup);
    await rename(sidecars.temporary, target);
    return true;
  }

  async #rollback(
    runId: RunId,
    source: string,
    manifest: UnityPatchManifest,
    initial: PatchDispositionRecord,
  ): Promise<PatchControlResultV1> {
    let state = initial;
    try {
      while (state.nextEntry > 0) {
        const index = state.nextEntry - 1;
        const entry = manifest.entries[index];
        if (entry === undefined) throw new Error("Patch rollback entry missing.");
        if (!(await this.#rollbackEntry(source, entry, state.actionId, index))) {
          state = await this.#update(runId, state, { phase: "indeterminate" });
          return this.#result(state);
        }
        state = await this.#update(runId, state, { nextEntry: index });
      }
      await this.#cleanSidecars(source, manifest, state.actionId);
      if (manifest.schemaVersion !== 1) {
        const base = await this.#tree(runId, manifest.baseTreeManifest);
        if (!sameTree(await snapshotUnityWorkspace(source), base)) {
          state = await this.#update(runId, state, { phase: "indeterminate" });
          return this.#result(state);
        }
      }
      state = await this.#update(runId, state, { phase: "conflict" });
      return this.#result(state);
    } catch {
      state = await this.#update(runId, state, { phase: "indeterminate" });
      return this.#result(state);
    }
  }

  async #rollbackEntry(
    source: string,
    entry: UnityPatchManifest["entries"][number],
    actionId: string,
    index: number,
  ): Promise<boolean> {
    const target = await this.#target(source, entry.path, false);
    const sidecars = this.#sidecars(target, actionId, index);
    const current = await fileDigest(target);
    const backup = await fileDigest(sidecars.backup);
    const after = artifactAfter(entry);
    if (
      entry.operation === "add" ||
      (entry.operation === "add-or-modify" && backup === undefined)
    ) {
      if (current === undefined) return true;
      if (current.contentDigest !== after?.contentDigest) return false;
      await rm(target);
      return true;
    }
    const expectedBase = baseDigest(entry) ?? backup?.contentDigest;
    if (backup === undefined) return current?.contentDigest === expectedBase;
    if (backup.contentDigest !== expectedBase) return false;
    if (current !== undefined) {
      if (current.contentDigest !== after?.contentDigest) return false;
      await rm(target);
    }
    await rename(sidecars.backup, target);
    return true;
  }

  async #stage(runId: RunId, artifact: ArtifactRef | undefined, target: string): Promise<void> {
    if (artifact === undefined) throw new Error("Patch content is missing.");
    const existing = await fileDigest(target);
    if (existing !== undefined) {
      if (existing.contentDigest !== artifact.contentDigest) {
        throw new HoneyBeeCoreError("artifact.integrity-failed", "Patch staging file conflicted.");
      }
      return;
    }
    const bytes = await this.#artifacts.getBytes({ runId, artifact });
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #verifyPatchContent(runId: RunId, manifest: UnityPatchManifest): Promise<void> {
    for (const entry of manifest.entries) {
      const references = [artifactBefore(entry), artifactAfter(entry)].filter(
        (artifact): artifact is ArtifactRef => artifact !== undefined,
      );
      for (const artifact of references) {
        await this.#artifacts.getBytes({ runId, artifact });
      }
    }
  }

  async #cleanSidecars(
    source: string,
    manifest: UnityPatchManifest,
    actionId: string,
  ): Promise<void> {
    for (const [index, entry] of manifest.entries.entries()) {
      const target = await this.#target(source, entry.path, false);
      const sidecars = this.#sidecars(target, actionId, index);
      await rm(sidecars.temporary, { force: true });
      await rm(sidecars.backup, { force: true });
    }
  }

  async #target(source: string, relative: string, createParents: boolean): Promise<string> {
    const root = path.resolve(source);
    const rootEntry = await lstat(root);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new HoneyBeeCoreError(
        "workspace.invalid-project",
        "Unity source is not a real directory.",
      );
    }
    const segments = safeSegments(relative);
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      directory = path.join(directory, segment);
      try {
        const entry = await lstat(directory);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Patch parent is not a real directory.",
          );
        }
      } catch (error) {
        if (
          !createParents ||
          error instanceof HoneyBeeCoreError ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
        await mkdir(directory);
        const created = await lstat(directory);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new HoneyBeeCoreError(
            "workspace.invalid-project",
            "Patch parent creation was intercepted.",
          );
        }
      }
    }
    const target = path.join(root, ...segments);
    if (!target.startsWith(root + path.sep)) {
      throw new HoneyBeeCoreError("workspace.invalid-project", "Patch target escaped source.");
    }
    return target;
  }

  #sidecars(target: string, actionId: string, index: number) {
    const prefix = ".honeybee-" + actionId + "-" + index;
    return {
      temporary: path.join(path.dirname(target), prefix + ".tmp"),
      backup: path.join(path.dirname(target), prefix + ".bak"),
    };
  }

  #sidecarRelatives(
    source: string,
    manifest: UnityPatchManifest,
    actionId: string,
  ): ReadonlySet<string> {
    const ignored = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      const target = path.join(path.resolve(source), ...safeSegments(entry.path));
      const sidecars = this.#sidecars(target, actionId, index);
      for (const sidecar of [sidecars.temporary, sidecars.backup]) {
        ignored.add(path.relative(source, sidecar).split(path.sep).join("/"));
      }
    }
    return ignored;
  }

  async #manifest(runId: RunId, patch: ArtifactRef): Promise<UnityPatchManifest> {
    if (
      patch.kind !== "unity-verified-patch" ||
      patch.mediaType !== "application/vnd.honeybee.unity-patch+json"
    ) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Artifact is not a verified patch.",
      );
    }
    return UnityPatchManifestSchema.parse(
      JSON.parse(await this.#artifacts.get({ runId, artifact: patch })) as unknown,
    );
  }

  async #tree(runId: RunId, artifact: ArtifactRef): Promise<UnityWorkspaceManifest> {
    return StoredTreeManifestSchema.parse(
      JSON.parse(await this.#artifacts.get({ runId, artifact })) as unknown,
    );
  }

  async #sourceState(
    runId: RunId,
    source: string,
    manifest: UnityPatchManifest,
  ): Promise<"clean" | "result" | "drift" | "unavailable"> {
    try {
      const current = await snapshotUnityWorkspace(source);
      const result = await this.#tree(runId, manifest.resultManifest);
      if (sameTree(current, result)) return "result";
      if (manifest.schemaVersion !== 1) {
        const base = await this.#tree(runId, manifest.baseTreeManifest);
        return sameTree(current, base) ? "clean" : "drift";
      }
      return "drift";
    } catch {
      return "unavailable";
    }
  }

  async #preview(
    runId: RunId,
    artifact: ArtifactRef | undefined,
    metadata: Readonly<{ byteLength: number; contentDigest: ContentDigest }> | undefined,
    remaining: number,
  ): Promise<Readonly<{ value?: PatchFileViewV1["before"]; used: number }>> {
    const reference = artifact ?? metadata;
    if (reference === undefined) return { used: 0 };
    if (artifact === undefined || artifact.byteLength > MAX_PREVIEW_BYTES || remaining <= 0) {
      return {
        used: 0,
        value: {
          contentDigest: reference.contentDigest,
          byteLength: reference.byteLength,
          format: artifact === undefined ? "unavailable" : "binary",
          truncated: artifact !== undefined,
        },
      };
    }
    const bytes = Buffer.from(await this.#artifacts.getBytes({ runId, artifact }));
    const text = bytes.toString("utf8");
    const textBytes = Buffer.from(text, "utf8");
    const textual = !bytes.includes(0) && textBytes.equals(bytes);
    if (!textual) {
      return {
        used: 0,
        value: {
          contentDigest: artifact.contentDigest,
          byteLength: artifact.byteLength,
          format: "binary",
          truncated: false,
        },
      };
    }
    const available = Math.min(bytes.byteLength, remaining, MAX_PREVIEW_BYTES);
    const preview = bytes.subarray(0, available).toString("utf8");
    return {
      used: available,
      value: {
        contentDigest: artifact.contentDigest,
        byteLength: artifact.byteLength,
        format: "text",
        text: preview,
        truncated: available < bytes.byteLength,
      },
    };
  }

  #newState(
    runId: RunId,
    patch: ArtifactRef,
    action: PatchActionV1,
    phase: PatchDispositionRecord["phase"],
    conflictPaths: readonly string[] = [],
  ): PatchDispositionRecord {
    const timestamp = this.now().toISOString();
    return PatchDispositionRecordSchema.parse({
      schemaVersion: 1,
      runId,
      patchArtifactId: patch.artifactId,
      actionId: randomUUID(),
      action,
      phase,
      nextEntry: 0,
      conflictPaths,
      startedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async #update(
    runId: RunId,
    state: PatchDispositionRecord,
    update: Partial<Pick<PatchDispositionRecord, "phase" | "nextEntry" | "conflictPaths">>,
  ): Promise<PatchDispositionRecord> {
    const next = PatchDispositionRecordSchema.parse({
      ...state,
      ...update,
      updatedAt: this.now().toISOString(),
    });
    await this.#writeState(runId, next);
    return next;
  }

  async #readState(runId: RunId, patch: ArtifactRef): Promise<PatchDispositionRecord | undefined> {
    await this.#repository.open(runId);
    const directory = path.resolve(this.root, runId);
    try {
      const value = PatchDispositionRecordSchema.parse(
        JSON.parse(
          await readFile(path.join(directory, "patch-disposition.json"), "utf8"),
        ) as unknown,
      );
      if (value.runId !== runId || value.patchArtifactId !== patch.artifactId) {
        throw new HoneyBeeCoreError("run.indeterminate", "Patch disposition identity mismatched.");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("run.indeterminate", "Patch disposition is corrupt.");
    }
  }

  async #writeState(runId: RunId, state: PatchDispositionRecord): Promise<void> {
    await this.#repository.open(runId);
    const directory = path.resolve(this.root, runId);
    const target = path.join(directory, "patch-disposition.json");
    const temporary = path.join(directory, ".patch-disposition-" + randomUUID() + ".tmp");
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(
        JSON.stringify(PatchDispositionRecordSchema.parse(state)) + "\n",
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #result(state: PatchDispositionRecord): PatchControlResultV1 {
    const disposition =
      state.phase === "applied" ||
      state.phase === "rejected" ||
      state.phase === "conflict" ||
      state.phase === "indeterminate"
        ? state.phase
        : "indeterminate";
    return PatchControlResultV1Schema.parse({
      schemaVersion: 1,
      runId: state.runId,
      patchArtifactId: state.patchArtifactId,
      action: state.action,
      disposition,
      conflictPaths: state.conflictPaths,
    });
  }
}
