export type AgentRole = "producer" | "reviewer";

export interface AgentCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AgentProcessRequest {
  readonly role: AgentRole;
  readonly prompt: string;
  readonly command: AgentCommand;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface AgentProcessResult {
  readonly role: AgentRole;
  readonly pid: number;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface AgentProcessRunner {
  run(request: AgentProcessRequest, onStarted?: (pid: number) => void): Promise<AgentProcessResult>;
}

export type HandoffEvent =
  | Readonly<{ type: "agent.started"; role: AgentRole; pid: number; command: string }>
  | Readonly<{
      type: "agent.completed";
      role: AgentRole;
      pid: number;
      durationMs: number;
      outputBytes: number;
    }>
  | Readonly<{
      type: "handoff.created";
      from: "producer";
      to: "reviewer";
      contentBytes: number;
    }>
  | Readonly<{ type: "workflow.completed"; resultBytes: number }>;

export interface HandoffRunRequest {
  readonly task: string;
  readonly producer: AgentCommand;
  readonly reviewer: AgentCommand;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface HandoffRunResult {
  readonly task: string;
  readonly producer: AgentProcessResult;
  readonly reviewer: AgentProcessResult;
  readonly handoff: string;
  readonly result: string;
}

export type HandoffEventListener = (event: HandoffEvent) => void;
