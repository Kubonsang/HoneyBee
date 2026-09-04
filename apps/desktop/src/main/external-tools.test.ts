import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveExternalTool } from "./external-tools.js";

describe("Desktop external tool resolution", () => {
  it("prefers PowerShell 7 and falls back to Windows PowerShell", async () => {
    const preferred = await resolveExternalTool(
      "powershell",
      "C:\\work",
      {},
      { locate: async (name) => (name === "pwsh.exe" ? "C:\\PowerShell\\pwsh.exe" : undefined) },
    );
    expect(preferred.executable).toContain("pwsh.exe");
    const fallback = await resolveExternalTool(
      "powershell",
      "C:\\work",
      {},
      {
        locate: async (name) =>
          name === "powershell.exe" ? "C:\\Windows\\powershell.exe" : undefined,
      },
    );
    expect(fallback.executable).toContain("powershell.exe");
  });

  it("reports an actionable error when VS Code is absent", async () => {
    await expect(
      resolveExternalTool(
        "vscode",
        "C:\\work",
        {},
        { locate: async () => undefined, isAvailable: async () => false },
      ),
    ).rejects.toMatchObject({ code: "tool.not-found" });
  });

  it("uses the exact Unity version from ProjectVersion.txt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-tool-"));
    await mkdir(path.join(root, "ProjectSettings"));
    await writeFile(
      path.join(root, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.0.42f1\n",
      "utf8",
    );
    const resolution = await resolveExternalTool(
      "unity",
      root,
      { ProgramFiles: "C:\\Program Files" },
      { isAvailable: async () => true },
    );
    expect(resolution.executable).toBe(
      "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.42f1\\Editor\\Unity.exe",
    );
    expect(resolution.args).toEqual(["-projectPath", root]);
  });
});
