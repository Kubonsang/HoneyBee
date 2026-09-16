import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import {
  cacheSeed,
  seedBee,
  assertLegacySeed,
  finishDataset,
  resumeMissingBeeDataset,
  inspectMissingBeeDataset,
} from "./integrated-dataset.mjs";

async function recoveryFixture() {
  const f = await fixture();
  const guest = {
    storeRoot: path.join(f.root, "store"),
    userSid: "qa-sid",
    installationRoot: path.join(f.root, "installation"),
  };
  for (const folder of [
    "children",
    "leases",
    "parents",
    "pending",
    "quarantine",
    "receipts",
    "retained",
  ])
    await mkdir(path.join(guest.storeRoot, guest.userSid, folder), { recursive: true });
  for (const folder of [".git", "Assets", "Packages", "ProjectSettings"])
    await mkdir(path.join(f.project, folder));
  for (const [file, data] of Object.entries({
    ".gitignore": "Library/\nTemp/\n",
    "Assets/Source.txt": "committed source\n",
    "Packages/manifest.json": '{"dependencies":{}}\n',
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
  }))
    await writeFile(path.join(f.project, file), data);
  const registry = {
    schemaVersion: 2,
    workspaces: [],
    removalReceipts: [],
    projects: [
      {
        projectId: "25e6825e-4c06-4095-8721-0b4cc2acd985",
        unityProjectPath: f.project,
        repositoryRoot: f.project,
        unityRelativePath: "",
        workspaceRoot: path.join(f.root, "QA 데이터", "Workspaces"),
        storageBinding: { kind: "managed-v1", installationRoot: guest.installationRoot },
      },
    ],
  };
  const run = async (_file, args) => ({
    stdout: args.includes("--show-current")
      ? "main\n"
      : args.includes("rev-list")
        ? "1\n"
        : args.includes("ls-files")
          ? ".gitignore\nAssets/Source.txt\nPackages/manifest.json\nProjectSettings/ProjectVersion.txt\n"
          : "",
  });
  return { ...f, guest, registry, run };
}

test("recovery admission accepts only an untouched registered seed with empty native state", async () => {
  const f = await recoveryFixture();
  assert.equal((await inspectMissingBeeDataset(f)).projectId, f.registry.projects[0].projectId);
  await assertLegacySeed(f.project); // inspection added nothing
  await writeFile(path.join(f.guest.storeRoot, f.guest.userSid, "pending/retain.json"), "retain");
  await assert.rejects(inspectMissingBeeDataset(f), /Retained storage state/);
});

test("recovery admission preserves existing cache, Workspace and changed source", async () => {
  for (const change of ["cache", "workspace", "source"]) {
    const f = await recoveryFixture();
    if (change === "cache") f.registry.projects[0].cache = { parentId: "retained" };
    if (change === "workspace") f.registry.workspaces.push({ id: "retained" });
    if (change === "source")
      await writeFile(path.join(f.project, "Assets/Source.txt"), "user changes");
    await assert.rejects(inspectMissingBeeDataset(f));
    await assertLegacySeed(f.project);
  }
});

async function fixture() {
  const base = path.resolve("output/integrated-dataset-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const project = path.join(root, "QA 데이터", "Unity 프로젝트");
  await mkdir(path.join(project, "Library"), { recursive: true });
  await writeFile(path.join(project, "Library/qa-cache.txt"), cacheSeed);
  return { root, project };
}

test("synthetic seed satisfies Bee tree contract and refuses to overwrite it", async () => {
  const { project } = await fixture();
  await assertLegacySeed(project);
  await seedBee(project);
  assert.equal(await readFile(path.join(project, "Library/Bee/qa-seed.txt"), "utf8"), cacheSeed);
  await assert.rejects(seedBee(project), { code: "EEXIST" });
  await assert.rejects(assertLegacySeed(project), /reviewed missing-Bee/);
});

test("reviewed seed admission rejects changed and extra data", async () => {
  const { project } = await fixture();
  await writeFile(path.join(project, "Library/qa-cache.txt"), "user data");
  await assert.rejects(assertLegacySeed(project));
  await writeFile(path.join(project, "Library/qa-cache.txt"), cacheSeed);
  await writeFile(path.join(project, "Library/extra.txt"), "keep");
  await assert.rejects(assertLegacySeed(project));
  assert.equal(await readFile(path.join(project, "Library/extra.txt"), "utf8"), "keep");
});

test("cache failure does not create a Workspace or dirty the project", async () => {
  const f = await fixture();
  const calls = [];
  await assert.rejects(
    finishDataset({
      ...f,
      projectId: "qa",
      cli: async (args) => {
        calls.push(args);
        throw Error("commit failure");
      },
    }),
    /commit failure/,
  );
  assert.deepEqual(calls, [["cache", "prepare", "--project", "qa"]]);
});

test("successful completion preserves synthetic Bee seed and creates actual dirty data", async () => {
  const f = await fixture();
  await seedBee(f.project);
  const workspacePath = path.join(f.root, "QA 데이터/Workspaces/preserved");
  for (const directory of [f.project, workspacePath]) {
    await mkdir(path.join(directory, "Assets"), { recursive: true });
    await writeFile(
      path.join(directory, "Assets/Source.txt"),
      directory === workspacePath ? "committed source\r\n" : "committed source\n",
    );
  }
  const calls = [];
  const result = await finishDataset({
    ...f,
    projectId: "qa",
    cli: async (args) => {
      calls.push(args);
      return { workspace: { state: "ready", available: true, workspacePath } };
    },
  });
  assert.equal(result.projectId, "qa");
  assert.equal(calls.length, 2);
  for (const directory of [f.project, workspacePath]) {
    assert.equal(
      await readFile(path.join(directory, "Assets/Source.txt"), "utf8"),
      "dirty tracked source\n",
    );
    assert.equal(
      await readFile(path.join(directory, "Assets/새 파일.txt"), "utf8"),
      "untracked source\n",
    );
  }
});

test("reviewed recovery refuses other bundle identities before running commands", async () => {
  let calls = 0;
  await assert.rejects(
    resumeMissingBeeDataset({ root: path.resolve("output/foreign"), run: async () => calls++ }),
  );
  assert.equal(calls, 0);
});
