import type { AgentLaunchSpec } from "@honeybee/agent-adapters";
import type { SessionId } from "@honeybee/domain";

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type ExitReason = "exited" | "interrupted" | "stopped" | "force-killed" | "spawn-failed";

export interface StartPtySessionRequest {
  readonly sessionId: SessionId;
  readonly launchSpec: AgentLaunchSpec;
  readonly size: TerminalSize;
  readonly logFilePath?: string;
}

export type PtySessionEvent =
  | Readonly<{
      type: "session.started";
      sessionId: SessionId;
      seq: number;
      pid: number;
      logFilePath: string;
    }>
  | Readonly<{
      type: "session.output";
      sessionId: SessionId;
      seq: number;
      data: string;
    }>
  | Readonly<{
      type: "session.exited";
      sessionId: SessionId;
      seq: number;
      exitCode: number | null;
      signal: number | null;
      reason: ExitReason;
    }>;

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly data: string;
  readonly byteLength: number;
  readonly truncatedBytes: number;
  readonly logFilePath: string;
}
