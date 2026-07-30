import type { AgentLaunchSpec } from "@honeybee/agent-adapters";
import type { RunId, SessionId } from "@honeybee/domain";

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type ExitReason =
  | "exited"
  | "interrupted"
  | "stopped"
  | "force-killed"
  | "spawn-failed"
  | "extension-shutdown"
  | "runtime-shutdown";

export interface StartPtySessionRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly launchSpec: AgentLaunchSpec;
  readonly size: TerminalSize;
  readonly logFilePath?: string;
}

export type PtySessionEvent =
  | Readonly<{
      type: "session.started";
      sessionId: SessionId;
      runId: RunId;
      seq: number;
      pid: number;
      logFilePath: string;
    }>
  | Readonly<{
      type: "session.output";
      sessionId: SessionId;
      runId: RunId;
      seq: number;
      data: string;
    }>
  | Readonly<{
      type: "session.exited";
      sessionId: SessionId;
      runId: RunId;
      seq: number;
      exitCode: number | null;
      signal: number | null;
      reason: ExitReason;
    }>;

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly data: string;
  readonly byteLength: number;
  readonly truncatedBytes: number;
  readonly logFilePath: string;
}

export interface PtyShutdownReport {
  readonly stoppedRuns: number;
  readonly unresolvedRuns: number;
}
