import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

import { DesktopMainError } from "./desktop-errors.js";
import { readUnityVersion } from "./project-onboarding.js";

const execFileAsync = promisify(execFile);
const available = async (target: string): Promise<boolean> =>
  access(target)
    .then(() => true)
    .catch(() => false);

const where = async (name: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("where.exe", [name], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find((item) => item.length > 0);
  } catch {
    return undefined;
  }
};

export interface ExternalToolResolution {
  readonly executable: string;
  readonly args: readonly string[];
}
export interface ExternalToolDependencies {
  readonly locate?: (name: string) => Promise<string | undefined>;
  readonly isAvailable?: (target: string) => Promise<boolean>;
}

export const resolveExternalTool = async (
  tool: "cmd" | "powershell" | "vscode" | "unity",
  workspacePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ExternalToolDependencies = {},
): Promise<ExternalToolResolution> => {
  const locate = dependencies.locate ?? where;
  const isAvailable = dependencies.isAvailable ?? available;
  if (tool === "cmd")
    return { executable: environment.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", args: ["/K"] };
  if (tool === "powershell") {
    const executable = (await locate("pwsh.exe")) ?? (await locate("powershell.exe"));
    if (executable === undefined)
      throw new DesktopMainError("tool.not-found", "PowerShell was not found.", [
        "Install PowerShell 7 or enable Windows PowerShell.",
      ]);
    return { executable, args: ["-NoExit"] };
  }
  if (tool === "vscode") {
    const candidates = [
      environment.LOCALAPPDATA === undefined
        ? undefined
        : path.join(environment.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
      environment.ProgramFiles === undefined
        ? undefined
        : path.join(environment.ProgramFiles, "Microsoft VS Code", "Code.exe"),
      environment["ProgramFiles(x86)"] === undefined
        ? undefined
        : path.join(environment["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
      await locate("Code.exe"),
    ].filter((item): item is string => item !== undefined);
    const executable = await candidates.reduce<Promise<string | undefined>>(
      async (current, candidate) =>
        (await current) ?? ((await isAvailable(candidate)) ? candidate : undefined),
      Promise.resolve(undefined),
    );
    if (executable === undefined)
      throw new DesktopMainError("tool.not-found", "Visual Studio Code was not found.", [
        "Install VS Code or add Code.exe to PATH.",
      ]);
    return { executable, args: [workspacePath] };
  }
  const version = await readUnityVersion(workspacePath);
  if (version === null)
    throw new DesktopMainError(
      "unity.editor-not-found",
      "ProjectVersion.txt does not contain an exact Unity editor version.",
      ["Open ProjectSettings/ProjectVersion.txt and verify m_EditorVersion."],
    );
  const programFiles = environment.ProgramFiles ?? "C:\\Program Files";
  const executable = path.join(
    programFiles,
    "Unity",
    "Hub",
    "Editor",
    version,
    "Editor",
    "Unity.exe",
  );
  if (!(await isAvailable(executable)))
    throw new DesktopMainError(
      "unity.editor-not-found",
      `Unity ${version} is not installed through Unity Hub.`,
      ["Install the exact editor version in Unity Hub."],
    );
  return { executable, args: ["-projectPath", workspacePath] };
};

export const launchExternalTool = async (
  resolution: ExternalToolResolution,
  cwd: string,
): Promise<void> => {
  const child = spawn(resolution.executable, [...resolution.args], {
    cwd,
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", () => undefined);
  child.unref();
};
