import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  DesktopAgentConnectResultV1Schema,
  DesktopAgentStatusV1Schema,
  type DesktopAgentConnectResultV1,
  type DesktopAgentProfileV1,
  type DesktopAgentProviderV1,
  type DesktopAgentStatusV1,
} from "../shared/ipc.js";
import type { DesktopSettingsStore } from "./settings.js";

const execFileAsync = promisify(execFile);
const MAX_PROBE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 8_000;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const preset = (provider: Exclude<DesktopAgentProviderV1, "custom">) =>
  provider === "codex"
    ? {
        displayName: "Codex",
        executable: "codex",
        args: ["exec", "--sandbox", "workspace-write", "--ephemeral", "--skip-git-repo-check", "-"],
      }
    : provider === "claude"
      ? {
          displayName: "Claude Code",
          executable: "claude",
          args: ["-p", "--output-format", "text"],
        }
      : { displayName: "OpenCode", executable: "opencode", args: ["run", "--pure"] };

const authenticationArgs = (provider: DesktopAgentProviderV1): readonly string[] | undefined =>
  provider === "codex"
    ? ["login", "status"]
    : provider === "claude"
      ? ["auth", "status"]
      : provider === "opencode"
        ? ["auth", "list"]
        : undefined;

const loginArgs = (provider: DesktopAgentProviderV1): readonly string[] | undefined =>
  provider === "codex"
    ? ["--login"]
    : provider === "claude"
      ? []
      : provider === "opencode"
        ? ["auth", "login"]
        : undefined;

const firstLine = (value: string): string | undefined => {
  const line = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line === undefined ? undefined : line.slice(0, 200);
};

export class DesktopAgentManager {
  public constructor(private readonly settings: DesktopSettingsStore) {}

  public async ensureDetected(): Promise<void> {
    if ((await this.settings.listAgents()).length > 0) return;
    for (const provider of ["codex", "claude", "opencode"] as const) {
      const definition = preset(provider);
      const executable = await this.#resolve(definition.executable);
      if (executable === undefined) continue;
      await this.settings.upsertAgent({
        schemaVersion: 1,
        displayName: definition.displayName,
        provider,
        command: { command: executable, args: [...definition.args] },
        enabled: true,
      });
    }
  }

  public async probe(profile: DesktopAgentProfileV1): Promise<DesktopAgentStatusV1> {
    const checkedAt = new Date().toISOString();
    if (!profile.enabled)
      return DesktopAgentStatusV1Schema.parse({
        schemaVersion: 1,
        agentId: profile.agentId,
        status: "disabled",
        checkedAt,
        summary: "This Agent profile is disabled.",
      });
    try {
      const versionResult = await execFileAsync(profile.command.command, ["--version"], {
        cwd: profile.command.cwd,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_BYTES,
        windowsHide: true,
      });
      const version = firstLine(versionResult.stdout || versionResult.stderr);
      const authArgs = authenticationArgs(profile.provider);
      if (authArgs !== undefined) {
        try {
          await execFileAsync(profile.command.command, [...authArgs], {
            cwd: profile.command.cwd,
            timeout: PROBE_TIMEOUT_MS,
            maxBuffer: MAX_PROBE_BYTES,
            windowsHide: true,
          });
        } catch {
          return DesktopAgentStatusV1Schema.parse({
            schemaVersion: 1,
            agentId: profile.agentId,
            status: "authentication-required",
            checkedAt,
            ...(version === undefined ? {} : { version }),
            summary: "The CLI is installed, but its provider account needs to be connected.",
          });
        }
      }
      return DesktopAgentStatusV1Schema.parse({
        schemaVersion: 1,
        agentId: profile.agentId,
        status: "ready",
        checkedAt,
        ...(version === undefined ? {} : { version }),
        summary: "The Agent CLI and provider authentication are ready.",
      });
    } catch (error) {
      const missing = errorCode(error) === "ENOENT";
      return DesktopAgentStatusV1Schema.parse({
        schemaVersion: 1,
        agentId: profile.agentId,
        status: missing ? "not-installed" : "probe-failed",
        checkedAt,
        summary: missing
          ? "The configured Agent executable could not be found."
          : "The Agent CLI did not complete its bounded version probe.",
      });
    }
  }

  public async connect(profile: DesktopAgentProfileV1): Promise<DesktopAgentConnectResultV1> {
    const args = loginArgs(profile.provider);
    if (args === undefined)
      return DesktopAgentConnectResultV1Schema.parse({
        schemaVersion: 1,
        agentId: profile.agentId,
        launched: false,
        message: "Custom Agents manage authentication outside HoneyBee.",
      });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(profile.command.command, [...args], {
        cwd: profile.command.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return DesktopAgentConnectResultV1Schema.parse({
      schemaVersion: 1,
      agentId: profile.agentId,
      launched: true,
      message:
        "The provider-owned login flow was launched. HoneyBee does not store its credentials.",
    });
  }

  async #resolve(command: string): Promise<string | undefined> {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    try {
      const result = await execFileAsync(locator, [command], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_BYTES,
        windowsHide: true,
      });
      const candidate = firstLine(result.stdout);
      return candidate === undefined ? undefined : path.resolve(candidate);
    } catch {
      return undefined;
    }
  }
}
