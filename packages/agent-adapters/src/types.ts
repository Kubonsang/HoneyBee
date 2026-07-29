import type { AgentProfileId, SessionId } from "@honeybee/domain";

export interface AgentLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: boolean;
}

export interface AgentLaunchRequest {
  readonly sessionId: SessionId;
  readonly cwd?: string;
  readonly additionalArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface AgentDetectionContext {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type AgentDetection =
  | Readonly<{
      available: true;
      profileId: AgentProfileId;
      resolvedCommand: string;
    }>
  | Readonly<{
      available: false;
      profileId: AgentProfileId;
      reason: "command-not-found" | "cwd-not-found";
    }>;

export interface AgentAdapter {
  detect(context?: AgentDetectionContext): Promise<AgentDetection>;
  createLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec;
}
