import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  FileArtifactStore,
  FileRunRepository,
  RunIdSchema,
  type ArtifactKind,
  type ArtifactMediaType,
  type ArtifactRef,
  type RunId,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import { FileUnityPatchControl } from "./unity-patch-control.js";
import { snapshotUnityWorkspace } from "./unity-patch.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-patch-control-"));
  roots.push(root);
  return root;
};

const prepareTree = async (root: string): Promise<void> => {
  await Promise.all(
    ["Assets", "Packages", "ProjectSettings"].map((name) =>
      mkdir(path.join(root, name), { recursive: true }),
    ),
  );
};

const put = async (
  store: FileArtifactStore,
  runId: RunId,
  kind: ArtifactKind,
  mediaType: ArtifactMediaType,
  content: string | Uint8Array,
): Promise<ArtifactRef> => {
  const request = {
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind,
    mediaType,
  };
  return typeof content === "string"
    ? store.put({ ...request, content })
    : store.putBytes({ ...request, content });
};

const seed = async (stateRoot: string, source: string) => {
  const runId = RunIdSchema.parse(randomUUID());
  await new FileRunRepository(stateRoot).create(runId);
  const artifacts = new FileArtifactStore(stateRoot);
  const baseTree = await snapshotUnityWorkspace(source);
  const baseManifest = await put(
    artifacts,
    runId,
    "unity-source-manifest",
    "application/json",
    JSON.stringify({ schemaVersion: 1, digest: "base" }),
  );
  const baseTreeArtifact = await put(
    artifacts,
    runId,
    "unity-workspace-manifest",
    "application/json",
    JSON.stringify(baseTree),
  );
  const beforeA = await put(
    artifacts,
    runId,
    "unity-patch-content",
    "application/octet-stream",
    "old\n",
  );
  const beforeDelete = await put(
    artifacts,
    runId,
    "unity-patch-content",
    "application/octet-stream",
    "remove\n",
  );
  const afterA = await put(
    artifacts,
    runId,
    "unity-patch-content",
    "application/octet-stream",
    "new\n",
  );
  const afterAdd = await put(
    artifacts,
    runId,
    "unity-patch-content",
    "application/octet-stream",
    "added\n",
  );

  const result = path.join(stateRoot, "result-" + randomUUID());
  await prepareTree(result);
  await writeFile(path.join(result, "Assets", "A.txt"), "new\n");
  await writeFile(path.join(result, "Assets", "Added.txt"), "added\n");
  await writeFile(path.join(result, "Packages", "manifest.json"), "{}\n");
  await writeFile(
    path.join(result, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.0.1f1\n",
  );
  const resultTree = await snapshotUnityWorkspace(result);
  const resultManifest = await put(
    artifacts,
    runId,
    "unity-workspace-manifest",
    "application/json",
    JSON.stringify(resultTree),
  );
  const patch = await put(
    artifacts,
    runId,
    "unity-verified-patch",
    "application/vnd.honeybee.unity-patch+json",
    JSON.stringify({
      schemaVersion: 2,
      baseManifest,
      baseTreeManifest: baseTreeArtifact,
      resultManifest,
      entries: [
        {
          path: "Assets/A.txt",
          operation: "modify",
          baseContentDigest: beforeA.contentDigest,
          before: beforeA,
          after: afterA,
        },
        { path: "Assets/Added.txt", operation: "add", after: afterAdd },
        {
          path: "Assets/Delete.txt",
          operation: "delete",
          baseContentDigest: beforeDelete.contentDigest,
          before: beforeDelete,
        },
      ],
    }),
  );
  return { runId, patch };
};

const sourceProject = async (root: string): Promise<string> => {
  const source = path.join(root, "source");
  await prepareTree(source);
  await writeFile(path.join(source, "Assets", "A.txt"), "old\n");
  await writeFile(path.join(source, "Assets", "Delete.txt"), "remove\n");
  await writeFile(path.join(source, "Packages", "manifest.json"), "{}\n");
  await writeFile(
    path.join(source, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.0.1f1\n",
  );
  return source;
};

describe("FileUnityPatchControl", () => {
  it("shows bounded file diffs and applies a verified patch idempotently", async () => {
    const root = await temporaryRoot();
    const source = await sourceProject(root);
    const seeded = await seed(path.join(root, "runs"), source);
    const control = new FileUnityPatchControl(path.join(root, "runs"));

    const before = await control.view({
      runId: seeded.runId,
      patch: seeded.patch,
      sourceProjectPath: source,
    });
    expect(before).toMatchObject({
      sourceState: "clean",
      disposition: "pending",
      allowedActions: ["apply", "reject"],
    });
    expect(before.files.map((file) => [file.path, file.operation])).toEqual([
      ["Assets/A.txt", "modify"],
      ["Assets/Added.txt", "add"],
      ["Assets/Delete.txt", "delete"],
    ]);
    expect(before.files[0]?.before?.text).toBe("old\n");
    expect(before.files[0]?.after?.text).toBe("new\n");

    const applied = await control.act({
      runId: seeded.runId,
      patch: seeded.patch,
      sourceProjectPath: source,
      action: "apply",
    });
    expect(applied.disposition).toBe("applied");
    expect(await readFile(path.join(source, "Assets", "A.txt"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(source, "Assets", "Added.txt"), "utf8")).toBe("added\n");
    await expect(readFile(path.join(source, "Assets", "Delete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(path.join(source, "Assets"))).some((name) => name.includes("honeybee")),
    ).toBe(false);
    expect(
      (
        await control.act({
          runId: seeded.runId,
          patch: seeded.patch,
          sourceProjectPath: source,
          action: "apply",
        })
      ).disposition,
    ).toBe("applied");
    expect(
      await control.view({
        runId: seeded.runId,
        patch: seeded.patch,
        sourceProjectPath: source,
      }),
    ).toMatchObject({ sourceState: "result", disposition: "applied", allowedActions: [] });
    await expect(control.assertDeletionSafe(seeded.runId)).resolves.toBeUndefined();
  });

  it("rejects without touching source and fails apply closed on source drift", async () => {
    const root = await temporaryRoot();
    const source = await sourceProject(root);
    const rejectedSeed = await seed(path.join(root, "rejected-runs"), source);
    const rejected = new FileUnityPatchControl(path.join(root, "rejected-runs"));
    expect(
      (
        await rejected.act({
          runId: rejectedSeed.runId,
          patch: rejectedSeed.patch,
          sourceProjectPath: source,
          action: "reject",
        })
      ).disposition,
    ).toBe("rejected");
    expect(await readFile(path.join(source, "Assets", "A.txt"), "utf8")).toBe("old\n");

    const driftSeed = await seed(path.join(root, "drift-runs"), source);
    await writeFile(path.join(source, "Assets", "A.txt"), "user edit\n");
    const drift = new FileUnityPatchControl(path.join(root, "drift-runs"));
    expect(
      await drift.view({
        runId: driftSeed.runId,
        patch: driftSeed.patch,
        sourceProjectPath: source,
      }),
    ).toMatchObject({ sourceState: "drift", allowedActions: ["reject"] });
    expect(
      (
        await drift.act({
          runId: driftSeed.runId,
          patch: driftSeed.patch,
          sourceProjectPath: source,
          action: "apply",
        })
      ).disposition,
    ).toBe("conflict");
    expect(await readFile(path.join(source, "Assets", "A.txt"), "utf8")).toBe("user edit\n");
  });

  it("blocks Run deletion when the durable disposition cannot be interpreted", async () => {
    const root = await temporaryRoot();
    const stateRoot = path.join(root, "runs");
    const source = await sourceProject(root);
    const seeded = await seed(stateRoot, source);
    const control = new FileUnityPatchControl(stateRoot);

    await writeFile(
      path.join(stateRoot, seeded.runId, "patch-disposition.json"),
      '{"schemaVersion":1',
      "utf8",
    );
    await expect(control.assertDeletionSafe(seeded.runId)).rejects.toMatchObject({
      code: "run.cleanup-pending",
    });
  });
});
