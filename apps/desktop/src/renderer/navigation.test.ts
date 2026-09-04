import { describe, expect, it } from "vitest";

import type { DesktopProjectV2 } from "../shared/ipc.js";
import { message, messageKeys } from "./i18n.js";
import { selectInitialProject } from "./navigation.js";

const project = (projectId: string): DesktopProjectV2 => ({
  projectId,
  label: projectId,
  unityProjectPath: `C:\\Unity\\${projectId}`,
  unityRelativePath: "",
  workspaceRoot: `D:\\HoneyBee\\${projectId}`,
  cacheState: "ready",
  unityVersion: "6000.0.42f1",
});

describe("Desktop renderer navigation and language", () => {
  it("uses the recent project and falls back to the first registered project", () => {
    const projects = [project("first"), project("recent")];
    expect(selectInitialProject(projects, "recent")?.projectId).toBe("recent");
    expect(selectInitialProject(projects, "missing")?.projectId).toBe("first");
    expect(selectInitialProject([], null)).toBeUndefined();
  });

  it("has non-empty Korean and English copy for every message key", () => {
    for (const key of messageKeys) {
      expect(message("ko", key).trim()).not.toBe("");
      expect(message("en", key).trim()).not.toBe("");
    }
    expect(message("ko", "newWorkspace")).not.toBe(message("en", "newWorkspace"));
  });
});
