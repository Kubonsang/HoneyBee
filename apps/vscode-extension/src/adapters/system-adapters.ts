import { randomUUID } from "node:crypto";

import {
  SessionIdSchema,
  type AgentProfileId,
  type SessionId,
  type ToolProfileId,
  type WorkspaceId,
} from "@honeybee/domain";

import type {
  AgentLaunchProfile,
  AgentProfileResolverPort,
  ClockPort,
  IdGeneratorPort,
} from "../application/ports.js";

export class SystemClock implements ClockPort {
  public now(): string {
    return new Date().toISOString();
  }
}

export class RandomIdGenerator implements IdGeneratorPort {
  public sessionId(): SessionId {
    return SessionIdSchema.parse(`session-${randomUUID()}`);
  }

  public runId(): string {
    return `run-${randomUUID()}`;
  }

  public requestId(): string {
    return `request-${randomUUID()}`;
  }
}

export interface AgentConfiguration {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: boolean;
}

export class ConfiguredAgentProfileResolver implements AgentProfileResolverPort {
  public constructor(private readonly readConfiguration: () => AgentConfiguration) {}

  public async resolve(
    _agentProfileId: AgentProfileId,
    _toolProfileId: ToolProfileId | undefined,
    _workspaceId: WorkspaceId | undefined,
  ): Promise<AgentLaunchProfile> {
    return this.readConfiguration();
  }
}
