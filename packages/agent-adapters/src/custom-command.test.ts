import { AgentProfileIdSchema, SessionIdSchema } from "@honeybee/domain";
import { describe, expect, it, vi } from "vitest";

import { AgentAdapterError, CustomCommandAgentAdapter } from "./index.js";

const profileId = AgentProfileIdSchema.parse("custom-codex");
const sessionId = SessionIdSchema.parse("session-1");

describe("CustomCommandAgentAdapter", () => {
  it("detects a command using the normalized Windows cwd and merged environment", async () => {
    const locator = vi.fn().mockResolvedValue("C:\\Tools\\agent.exe");
    const adapter = new CustomCommandAgentAdapter(
      {
        id: profileId,
        command: "agent",
        cwd: "C:\\repo",
        env: { AGENT_MODE: "test" },
      },
      {
        platform: "win32",
        processEnv: { Path: "C:\\Windows\\System32" },
        commandLocator: locator,
        directoryExists: async () => true,
      },
    );

    const detection = await adapter.detect({ env: { EXTRA: "1" } });

    expect(detection).toEqual({
      available: true,
      profileId,
      resolvedCommand: "C:\\Tools\\agent.exe",
    });
    expect(locator).toHaveBeenCalledWith(
      "agent",
      "C:\\repo",
      expect.objectContaining({ Path: "C:\\Windows\\System32", AGENT_MODE: "test", EXTRA: "1" }),
      "win32",
    );
  });

  it("reports missing cwd and command without spawning a shell", async () => {
    const missingDirectory = new CustomCommandAgentAdapter(
      { id: profileId, command: "agent", cwd: "C:\\missing" },
      {
        platform: "win32",
        processEnv: {},
        commandLocator: async () => "C:\\agent.exe",
        directoryExists: async () => false,
      },
    );
    const missingCommand = new CustomCommandAgentAdapter(
      { id: profileId, command: "agent", cwd: "C:\\repo" },
      {
        platform: "win32",
        processEnv: {},
        commandLocator: async () => undefined,
        directoryExists: async () => true,
      },
    );

    expect(await missingDirectory.detect()).toEqual({
      available: false,
      profileId,
      reason: "cwd-not-found",
    });
    expect(await missingCommand.detect()).toEqual({
      available: false,
      profileId,
      reason: "command-not-found",
    });
  });

  it("keeps command and args separate, defaults shell to false, and merges Windows env", () => {
    const definitionArgs = ["--profile", "safe"];
    const adapter = new CustomCommandAgentAdapter(
      {
        id: profileId,
        command: "C:\\Program Files\\Agent\\agent.exe",
        args: definitionArgs,
        cwd: "C:\\프로젝트 파일\\Hive (A)",
        env: { PATH: "C:\\Tools", PROFILE_TOKEN: "profile" },
      },
      {
        platform: "win32",
        processEnv: { Path: "C:\\Windows", BASE: "base", SKIP: "inherited" },
      },
    );

    const launch = adapter.createLaunchSpec({
      sessionId,
      cwd: "C:\\프로젝트 파일\\Hive (A)\\child\\..\\worktree",
      additionalArgs: ["--prompt", 'literal "quote" & | ^ %PATH%'],
      env: { PROFILE_TOKEN: "request", EXTRA: "value", SKIP: undefined },
    });

    expect(launch).toEqual({
      command: "C:\\Program Files\\Agent\\agent.exe",
      args: ["--profile", "safe", "--prompt", 'literal "quote" & | ^ %PATH%'],
      cwd: "C:\\프로젝트 파일\\Hive (A)\\worktree",
      env: {
        BASE: "base",
        PATH: "C:\\Tools",
        PROFILE_TOKEN: "request",
        EXTRA: "value",
        HONEYBEE_SESSION_ID: "session-1",
      },
      shell: false,
    });
    expect(definitionArgs).toEqual(["--profile", "safe"]);
  });

  it("honors an explicit shell setting and rejects missing launch cwd", () => {
    const shellAdapter = new CustomCommandAgentAdapter(
      { id: profileId, command: "agent", cwd: "C:\\repo", shell: true },
      { platform: "win32", processEnv: {} },
    );
    const missingCwdAdapter = new CustomCommandAgentAdapter(
      { id: profileId, command: "agent" },
      { platform: "win32", processEnv: {} },
    );

    expect(shellAdapter.createLaunchSpec({ sessionId }).shell).toBe(true);
    expect(() => missingCwdAdapter.createLaunchSpec({ sessionId })).toThrowError(AgentAdapterError);
  });
});
