import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { FileOsUnityEditorRegistry } from "./unity-editor-registry.js";

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
});
