import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
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
import {
  captureAgentLaunchTrust,
  HoneyBeeCoreError,
  verifyAgentLaunchTrust,
  type AgentTrustPath,
} from "@honeybee/core";
import type { DesktopAgentUpsertRequestV1 } from "../shared/ipc.js";
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

const exactSessionVersion = (
  profile: DesktopAgentProfileV1,
  version: string | undefined,
): boolean => {
  if (profile.adapter === "stdio-framed-v2") return true;
  const expected = profile.adapter === "codex-app-server-v1" ? "0.146.0" : "1.18.16";
  return version?.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u)?.[0] === expected;
};

export class DesktopAgentManager {
  public constructor(private readonly settings: DesktopSettingsStore) {}

  public async ensureDetected(): Promise<void> {
    if ((await this.settings.listAgents()).length > 0) return;
    for (const provider of ["codex", "claude", "opencode"] as const) {
      const definition = preset(provider);
      const executable = await this.#resolve(definition.executable);
      if (executable === undefined) continue;
      await this.upsert({
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
    if (profile.trust === undefined) {
      return DesktopAgentStatusV1Schema.parse({
        schemaVersion: 1,
        agentId: profile.agentId,
        status: "trust-required",
        checkedAt,
        summary: "Review and save this Agent again before HoneyBee executes it.",
      });
    }
    try {
      await verifyAgentLaunchTrust(profile.command, profile.trust);
      const versionResult = await execFileAsync(profile.command.command, ["--version"], {
        cwd: profile.command.cwd,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_BYTES,
        windowsHide: true,
      });
      const version = firstLine(versionResult.stdout || versionResult.stderr);
      if (!exactSessionVersion(profile, version)) {
        return DesktopAgentStatusV1Schema.parse({
          schemaVersion: 1,
          agentId: profile.agentId,
          status: "unsupported-version",
          checkedAt,
          ...(version === undefined ? {} : { version }),
          summary:
            profile.adapter === "codex-app-server-v1"
              ? "Experimental Codex sessions require exactly Codex CLI 0.146.0."
              : "Experimental OpenCode sessions require exactly OpenCode 1.18.16.",
        });
      }
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
      if (error instanceof HoneyBeeCoreError && error.code.startsWith("agent.trust")) {
        return DesktopAgentStatusV1Schema.parse({
          schemaVersion: 1,
          agentId: profile.agentId,
          status: "trust-changed",
          checkedAt,
          summary: "The approved Agent launch content changed. Review and trust it again.",
        });
      }
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
    if (profile.trust === undefined) {
      throw new HoneyBeeCoreError("agent.trust-required", "Agent trust approval is required.");
    }
    await verifyAgentLaunchTrust(profile.command, profile.trust);
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

  public async upsert(request: DesktopAgentUpsertRequestV1): Promise<DesktopAgentProfileV1> {
    const commandPath = path.isAbsolute(request.command.command)
      ? path.resolve(request.command.command)
      : await this.#resolve(request.command.command);
    if (commandPath === undefined) {
      throw new HoneyBeeCoreError(
        "agent.trust-invalid",
        "The Agent executable could not be resolved to an approved absolute path.",
      );
    }
    const trustPaths: AgentTrustPath[] = [{ role: "entrypoint", path: commandPath }];
    const explicit = (request.payloadPaths ?? []).map((candidate) => path.resolve(candidate));
    for (const candidate of explicit) trustPaths.push({ role: "payload", path: candidate });
    const scriptHosts = new Set([
      "node",
      "node.exe",
      "python",
      "python.exe",
      "python3",
      "python3.exe",
      "powershell",
      "powershell.exe",
      "pwsh",
      "pwsh.exe",
      "cmd.exe",
    ]);
    if (
      request.provider === "custom" &&
      scriptHosts.has(path.basename(commandPath).toLowerCase()) &&
      explicit.length === 0 &&
      (request.command.args?.length ?? 0) > 0
    ) {
      throw new HoneyBeeCoreError(
        "agent.trust-invalid",
        "Interpreter-based custom Agents must declare their launch payload files.",
      );
    }
    if (process.platform === "win32" && path.extname(commandPath).toLowerCase() === ".cmd") {
      const metadata = await lstat(commandPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROBE_BYTES) {
        throw new HoneyBeeCoreError("agent.trust-invalid", "Agent command shim is unsafe.");
      }
      const source = await readFile(commandPath, "utf8");
      const localPayloads = new Set<string>();
      for (const match of source.matchAll(/%dp0%[\\/]([^"\r\n]+?\.(?:exe|[cm]?js))/giu)) {
        if (match[1] === undefined) continue;
        const candidate = path.resolve(path.dirname(commandPath), match[1]);
        const entry = await lstat(candidate).catch(() => undefined);
        if (entry?.isFile() === true && !entry.isSymbolicLink()) localPayloads.add(candidate);
      }
      if (localPayloads.size === 0 && explicit.length === 0) {
        throw new HoneyBeeCoreError(
          "agent.trust-invalid",
          "The Agent command shim payload could not be resolved.",
        );
      }
      for (const candidate of localPayloads) trustPaths.push({ role: "payload", path: candidate });
      if ([...localPayloads].some((candidate) => /\.[cm]?js$/iu.test(candidate))) {
        const node = await this.#resolve("node");
        if (node === undefined) {
          throw new HoneyBeeCoreError(
            "agent.trust-invalid",
            "The Agent shim requires Node, but node.exe could not be resolved.",
          );
        }
        trustPaths.push({ role: "interpreter", path: node });
      }
    } else if (
      ![".exe", ""].includes(path.extname(commandPath).toLowerCase()) &&
      explicit.length === 0
    ) {
      throw new HoneyBeeCoreError(
        "agent.trust-invalid",
        "Script-based custom Agents must declare their launch payload files.",
      );
    }
    const trust = await captureAgentLaunchTrust(trustPaths);
    return this.settings.upsertAgent(
      {
        ...request,
        command: { ...request.command, command: commandPath },
      },
      trust,
    );
  }

  async #resolve(command: string): Promise<string | undefined> {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    try {
      const result = await execFileAsync(locator, [command], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_BYTES,
        windowsHide: true,
      });
      const candidates = result.stdout
        .split(/\r?\n/u)
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => {
          if (process.platform !== "win32") return true;
          return [".exe", ".cmd"].includes(path.extname(candidate).toLowerCase());
        })
        .sort((left, right) => {
          const rank = (candidate: string) =>
            path.extname(candidate).toLowerCase() === ".exe" ? 0 : 1;
          return rank(left) - rank(right) || left.localeCompare(right);
        });
      return candidates[0];
    } catch {
      return undefined;
    }
  }
}
