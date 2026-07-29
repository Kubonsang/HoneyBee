import type { AgentLaunchSpec } from "@honeybee/agent-adapters";

import type { TerminalSize } from "./types.js";

export interface Disposable {
  dispose(): void;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface PtyProcessPort {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExitEvent) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyFactoryPort {
  spawn(launchSpec: AgentLaunchSpec, size: TerminalSize): PtyProcessPort;
}
