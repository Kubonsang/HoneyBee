import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EventIdSchema,
  RunIdSchema,
  StepIdSchema,
  UnityEditorObservationV1Schema,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import type { UnityProcessControl } from "./process-control.js";
import { FileOsUnityEditorRegistry, parseUnityEditorProcesses } from "./unity-editor-registry.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-editor-registry-"));
  roots.push(root);
  return root;
};

const processes = (identities: ReadonlyMap<number, string>): UnityProcessControl => ({
  captureIdentity: async (pid) => identities.get(pid),
  drain: async () => "drained",
});

describe("FileOsUnityEditorRegistry", () => {
  it("normalizes a singleton PowerShell discovery object", () => {
    expect(
      parseUnityEditorProcesses({
        pid: 100,
        executablePath: "C:\\Unity.exe",
        commandLine: "Unity.exe -projectPath C:\\Game",
      }),
    ).toEqual([
      {
        pid: 100,
        executablePath: "C:\\Unity.exe",
        commandLine: "Unity.exe -projectPath C:\\Game",
      },
    ]);
    expect(parseUnityEditorProcesses([])).toEqual([]);
    expect(parseUnityEditorProcesses("invalid")).toEqual([]);
  });

  it("observes path-known user and path-unknown Editors without ownership linkage", async () => {
    const root = await temporaryRoot();
    const userProject = path.join(root, "Game Project");
    const registry = new FileOsUnityEditorRegistry(
      root,
      async () => [
        {
          pid: 101,
          executablePath: path.join(root, "Unity"),
          commandLine: `Unity -projectPath "${userProject}"`,
        },
        { pid: 102, executablePath: path.join(root, "Unity") },
      ],
      processes(
        new Map([
          [101, "win32:101"],
          [102, "win32:102"],
        ]),
      ),
      () => new Date(0),
    );
    const editors = await registry.list();
    expect(editors).toHaveLength(2);
    expect(editors[0]).toMatchObject({ pid: 101, ownership: "user", pathObservation: "confirmed" });
    expect(editors[1]).toMatchObject({
      pid: 102,
      ownership: "unknown",
      pathObservation: "unavailable",
    });
    for (const editor of editors) {
      expect(editor.ownerRunId).toBeUndefined();
      expect(editor.ownerWorkId).toBeUndefined();
      expect(editor.slotId).toBeUndefined();
      expect(editor.launchId).toBeUndefined();
    }
  });

  it("recognizes only an exact durable PID incarnation as HoneyBee-owned", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "Workspace");
    const identities = new Map([[201, "win32:original"]]);
    const registry = new FileOsUnityEditorRegistry(
      root,
      async () => [{ pid: 201, commandLine: `Unity -projectPath "${workspace}"` }],
      processes(identities),
      () => new Date(0),
    );
    const owned = UnityEditorObservationV1Schema.parse({
      schemaVersion: 1,
      editorId: EventIdSchema.parse(randomUUID()),
      pid: 201,
      processIdentity: "win32:original",
      projectPath: workspace,
      workspaceId: "hb-work",
      ownership: "honeybee",
      ownerRunId: RunIdSchema.parse(randomUUID()),
      ownerWorkId: StepIdSchema.parse("work-a"),
      slotId: "editor-1",
      launchId: EventIdSchema.parse(randomUUID()),
      state: "alive",
      pathObservation: "confirmed",
      observedAt: new Date(0).toISOString(),
    });
    await registry.recordOwned(owned);
    expect((await registry.list())[0]?.ownership).toBe("honeybee");

    identities.set(201, "win32:reused");
    const reused = await registry.list();
    expect(
      reused.some(
        (editor) => editor.processIdentity === "win32:reused" && editor.ownership === "user",
      ),
    ).toBe(true);
    expect(
      reused.some(
        (editor) => editor.processIdentity === "win32:original" && editor.state === "stale",
      ),
    ).toBe(true);
  });

  it("records an immutable exit tombstone idempotently", async () => {
    const root = await temporaryRoot();
    const editorId = EventIdSchema.parse(randomUUID());
    let time = 0;
    const registry = new FileOsUnityEditorRegistry(
      root,
      async () => [],
      processes(new Map()),
      () => new Date(time++),
    );

    await registry.recordExited(editorId);
    const tombstonePath = path.join(root, ".unity-editors", "v1", "exited", `${editorId}.json`);
    const original = await readFile(tombstonePath, "utf8");
    await registry.recordExited(editorId);
    expect(await readFile(tombstonePath, "utf8")).toBe(original);

    await writeFile(tombstonePath, JSON.stringify({ schemaVersion: 1, editorId: randomUUID() }));
    await expect(registry.recordExited(editorId)).rejects.toMatchObject({
      code: "run.indeterminate",
    });
  });
});
