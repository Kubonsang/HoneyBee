import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  FileArtifactStore,
  FileRunRepository,
  RunIdSchema,
  UnityPatchManifestV2Schema,
  type ArtifactKind,
  type ArtifactMediaType,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import { UnityProjectBootstrap } from "./unity-adapters.js";
import { UnityPatchBuilder } from "./unity-patch.js";

const directories: string[] = [];
const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-patch-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

const createProject = async (root: string): Promise<void> => {
  await Promise.all(
    ["Assets", "Packages", "ProjectSettings"].map((directory) =>
      mkdir(path.join(root, directory), { recursive: true }),
    ),
  );
  await writeFile(path.join(root, "Assets", "modify.bin"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "Assets", "delete.txt"), "delete me", "utf8");
  await writeFile(path.join(root, "Packages", "manifest.json"), "{}", "utf8");
  await writeFile(
    path.join(root, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: test",
    "utf8",
  );
};

describe("UnityPatchBuilder", () => {
  it("stores changed bytes as content-addressed Artifacts and publishes only references", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "source");
    const workspaceParent = path.join(directory, "workspaces");
    const workspace = path.join(workspaceParent, "workspace");
    const runRoot = path.join(directory, "runs");
    const runId = RunIdSchema.parse(randomUUID());
    await createProject(source);
    await mkdir(workspaceParent, { recursive: true });
    const bootstrap = new UnityProjectBootstrap();
    await bootstrap.prepare(source, workspaceParent, "workspace");
    await writeFile(path.join(workspace, "Assets", "modify.bin"), Buffer.from([255, 0, 128]));
    await unlink(path.join(workspace, "Assets", "delete.txt"));
    await writeFile(path.join(workspace, "Assets", "added.txt"), "added", "utf8");

    await new FileRunRepository(runRoot).create(runId);
    const artifacts = new FileArtifactStore(runRoot);
    const baseManifest = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "unity-source-manifest",
      mediaType: "application/json",
      content: "{}",
    });
    let sourceChecks = 0;
    const publishBytes = (kind: ArtifactKind, mediaType: ArtifactMediaType, content: Uint8Array) =>
      artifacts.putBytes({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind,
        mediaType,
        content,
      });
    const publishJson = (kind: ArtifactKind, value: unknown) =>
      artifacts.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind,
        mediaType:
          kind === "unity-verified-patch"
            ? "application/vnd.honeybee.unity-patch+json"
            : "application/json",
        content: JSON.stringify(value),
      });

    const verified = await new UnityPatchBuilder(
      artifacts,
      bootstrap,
      path.join(directory, "scratch"),
    ).build({
      runId,
      sourceProjectPath: source,
      workspacePath: workspace,
      baseManifest,
      verifySource: async () => {
        sourceChecks += 1;
      },
      publishBytes,
      publishJson,
    });

    const serialized = await artifacts.get({ runId, artifact: verified.patch });
    const manifest = UnityPatchManifestV2Schema.parse(JSON.parse(serialized) as unknown);
    expect(sourceChecks).toBe(2);
    expect(manifest.entries.map((entry) => [entry.path, entry.operation])).toEqual([
      ["Assets/added.txt", "add"],
      ["Assets/delete.txt", "delete"],
      ["Assets/modify.bin", "modify"],
    ]);
    expect(serialized).not.toContain("contentBase64");
    const modified = manifest.entries.find((entry) => entry.path === "Assets/modify.bin");
    expect(modified?.operation).toBe("modify");
    if (modified?.operation !== "modify") throw new Error("missing modified entry");
    if (modified.before === undefined) throw new Error("missing base content");
    expect(Buffer.from(await artifacts.getBytes({ runId, artifact: modified.after }))).toEqual(
      Buffer.from([255, 0, 128]),
    );
    expect(Buffer.from(await artifacts.getBytes({ runId, artifact: modified.before }))).toEqual(
      Buffer.from([0, 1, 2]),
    );
    expect(manifest.baseTreeManifest.kind).toBe("unity-workspace-manifest");
    expect(verified.resultManifest.kind).toBe("unity-workspace-manifest");
    expect(await readFile(path.join(source, "Assets", "delete.txt"), "utf8")).toBe("delete me");
  });

  it("rejects a hard-linked workspace file before publishing a patch", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "source");
    const workspaceParent = path.join(directory, "workspaces");
    const workspace = path.join(workspaceParent, "workspace");
    const runRoot = path.join(directory, "runs");
    const runId = RunIdSchema.parse(randomUUID());
    await createProject(source);
    await mkdir(workspaceParent, { recursive: true });
    const bootstrap = new UnityProjectBootstrap();
    await bootstrap.prepare(source, workspaceParent, "workspace");
    await link(
      path.join(workspace, "Assets", "modify.bin"),
      path.join(workspace, "Assets", "linked.bin"),
    );
    await new FileRunRepository(runRoot).create(runId);
    const artifacts = new FileArtifactStore(runRoot);
    const baseManifest = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "unity-source-manifest",
      mediaType: "application/json",
      content: "{}",
    });
    const builder = new UnityPatchBuilder(artifacts, bootstrap, path.join(directory, "scratch"));

    await expect(
      builder.build({
        runId,
        sourceProjectPath: source,
        workspacePath: workspace,
        baseManifest,
        verifySource: async () => undefined,
        publishBytes: (kind, mediaType, content) =>
          artifacts.putBytes({
            runId,
            artifactId: ArtifactIdSchema.parse(randomUUID()),
            kind,
            mediaType,
            content,
          }),
        publishJson: (kind, value) =>
          artifacts.put({
            runId,
            artifactId: ArtifactIdSchema.parse(randomUUID()),
            kind,
            mediaType: "application/json",
            content: JSON.stringify(value),
          }),
      }),
    ).rejects.toMatchObject({ code: "workspace.invalid-project" });
  });

  it("fails closed before ingesting a changed file larger than 16 MiB", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "source");
    const workspaceParent = path.join(directory, "workspaces");
    const workspace = path.join(workspaceParent, "workspace");
    const runRoot = path.join(directory, "runs");
    const runId = RunIdSchema.parse(randomUUID());
    await createProject(source);
    await mkdir(workspaceParent, { recursive: true });
    const bootstrap = new UnityProjectBootstrap();
    await bootstrap.prepare(source, workspaceParent, "workspace");
    await writeFile(
      path.join(workspace, "Assets", "too-large.bin"),
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );
    await new FileRunRepository(runRoot).create(runId);
    const artifacts = new FileArtifactStore(runRoot);
    const baseManifest = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "unity-source-manifest",
      mediaType: "application/json",
      content: "{}",
    });

    await expect(
      new UnityPatchBuilder(artifacts, bootstrap, path.join(directory, "scratch")).build({
        runId,
        sourceProjectPath: source,
        workspacePath: workspace,
        baseManifest,
        verifySource: async () => undefined,
        publishBytes: (kind, mediaType, content) =>
          artifacts.putBytes({
            runId,
            artifactId: ArtifactIdSchema.parse(randomUUID()),
            kind,
            mediaType,
            content,
          }),
        publishJson: (kind, value) =>
          artifacts.put({
            runId,
            artifactId: ArtifactIdSchema.parse(randomUUID()),
            kind,
            mediaType: "application/json",
            content: JSON.stringify(value),
          }),
      }),
    ).rejects.toMatchObject({ code: "patch.too-large" });
  });
});
