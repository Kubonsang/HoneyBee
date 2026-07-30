import type {
  AgentProfileId,
  SessionId,
  SessionStatus,
  ToolProfileId,
  WorkspaceId,
} from "@honeybee/domain";

export interface ClockPort {
  now(): string;
}

export interface IdGeneratorPort {
  sessionId(): SessionId;
  runId(): string;
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

export type RuntimeClientEvent =
  | {
      readonly type: "connection";
      readonly state: RuntimeConnectionState;
      readonly message: string;
    }
  | {
      readonly type: "pty.data";
      readonly sessionId: SessionId;
      readonly sequence: number;
      readonly data: string;
    }
  | {
      readonly type: "session.status";
      readonly sessionId: SessionId;
      readonly status: SessionStatus;
      readonly message: string;
    }
  | {
      readonly type: "runtime.error";
      readonly sessionId?: SessionId;
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };

export interface RuntimeStartRequest extends AgentLaunchProfile {
  readonly sessionId: SessionId;
  readonly columns: number;
  readonly rows: number;
}

export interface RuntimeClientPort {
  readonly connectionState: RuntimeConnectionState;
  connect(): Promise<void>;
  start(request: RuntimeStartRequest): Promise<void>;
  sendInput(sessionId: SessionId, data: string): Promise<RuntimeInputOutcome>;
  resize(sessionId: SessionId, columns: number, rows: number): Promise<void>;
  interrupt(sessionId: SessionId): Promise<void>;
  stop(sessionId: SessionId): Promise<void>;
  onEvent(listener: (event: RuntimeClientEvent) => void): { dispose(): void };
  dispose(): Promise<void>;
}
