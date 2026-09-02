import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DesktopPreferencesStore } from "./desktop-preferences.js";

describe("DesktopPreferencesStore", () => {
  it("returns conservative defaults and persists validated preferences", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-preferences-"));
    const store = new DesktopPreferencesStore(root);
    expect(await store.read()).toMatchObject({ density: "comfortable", workbenchDefault: "files" });
    const next = {
      schemaVersion: 1 as const,
      density: "compact" as const,
      terminalFontSize: 14,
      fileExplorerWidth: 320,
      workbenchDefault: "agent" as const,
      reducedMotion: true,
    };
    await store.update(next);
    expect(await store.read()).toEqual(next);
    expect(JSON.parse(await readFile(path.join(root, "preferences-v1.json"), "utf8"))).toEqual(
      next,
    );
  });

  it("fails closed on unknown preference fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-preferences-"));
    await writeFile(
      path.join(root, "preferences-v1.json"),
      JSON.stringify({
        ...((await new DesktopPreferencesStore(root).read()) as object),
        typo: true,
      }),
      "utf8",
    );
    await expect(new DesktopPreferencesStore(root).read()).rejects.toMatchObject({
      code: "desktop.preferences-invalid",
    });
  });
});
