import type {
  AgentProfileId,
  RunId,
  RuntimeInstanceId,
  SessionId,
  SessionStatus,
  SessionTerminationReason,
  ToolProfileId,
  WorkspaceId,
} from "@honeybee/domain";

export interface ClockPort {
  now(): string;
}

export interface IdGeneratorPort {
  sessionId(): SessionId;
  runId(): RunId;
  requestId(): string;
}

export interface AgentLaunchProfile {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: boolean;
}

export interface AgentProfileResolverPort {
  resolve(
    agentProfileId: AgentProfileId,
    toolProfileId: ToolProfileId | undefined,
    workspaceId: WorkspaceId | undefined,
  ): Promise<AgentLaunchProfile>;
}

/** Local observation of one Runtime input request, including transport ambiguity. */
export type RuntimeInputOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "unknown"; readonly reason: string };
export type RuntimeConnectionState = "connecting" | "connected" | "disconnected" | "error";
export type RuntimeConnectionCause =
  "connect" | "intentional-shutdown" | "unexpected-disconnect" | "runtime-error";

export interface RuntimeHello {
  readonly protocolVersion: number;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly pid: number;
}

export type RuntimeShutdownReason = "extension-shutdown" | "runtime-shutdown";

export interface RuntimeShutdownResult {
  readonly state: "stopped";
  readonly stoppedRuns: number;
  readonly unresolvedRuns: number;
}

export type RuntimeClientEvent =
  | {
      readonly type: "connection";
      readonly state: RuntimeConnectionState;
      readonly cause: RuntimeConnectionCause;
      readonly message: string;
    }
  | {
      readonly type: "pty.data";
      readonly sessionId: SessionId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly data: string;
    }
  | {
      readonly type: "session.status";
      readonly sessionId: SessionId;
      readonly runId: RunId;
      readonly status: SessionStatus;
      readonly message: string;
      readonly reason?: SessionTerminationReason;
      readonly exitCode?: number;
    }
  | {
      readonly type: "runtime.error";
      readonly sessionId?: SessionId;
      readonly runId?: RunId;
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };

/** Run-resolving input boundary used by Prompt durability services. */
export interface PromptRuntimeInputPort {
  sendInput(sessionId: SessionId, data: string): Promise<RuntimeInputOutcome>;
}
export interface RuntimeStartRequest extends AgentLaunchProfile {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly columns: number;
  readonly rows: number;
}

export interface RuntimeClientPort {
  readonly connectionState: RuntimeConnectionState;
  readonly runtimeHello: RuntimeHello | undefined;
  connect(): Promise<void>;
  start(request: RuntimeStartRequest): Promise<void>;
  sendInput(sessionId: SessionId, data: string, runId: RunId): Promise<RuntimeInputOutcome>;
  resize(sessionId: SessionId, columns: number, rows: number, runId: RunId): Promise<void>;
  interrupt(sessionId: SessionId, runId: RunId): Promise<void>;
  stop(sessionId: SessionId, runId: RunId): Promise<void>;
  shutdown(reason: RuntimeShutdownReason): Promise<RuntimeShutdownResult>;
  onEvent(listener: (event: RuntimeClientEvent) => void): { dispose(): void };
  dispose(): Promise<void>;
}
