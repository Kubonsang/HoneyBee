import * as nodePty from "node-pty";

import type { AgentLaunchSpec } from "@honeybee/agent-adapters";

import { RuntimeOperationError } from "./errors.js";
import type { Disposable, PtyExitEvent, PtyFactoryPort, PtyProcessPort } from "./pty-port.js";
import type { TerminalSize } from "./types.js";

class BufferedNodePtyProcess implements PtyProcessPort {
  public readonly pid: number;
  readonly #process: nodePty.IPty;
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: PtyExitEvent) => void>();
  readonly #pendingData: string[] = [];
  #exit: PtyExitEvent | undefined;

  public constructor(process: nodePty.IPty) {
    this.#process = process;
    this.pid = process.pid;
    process.onData((data) => {
      if (this.#dataListeners.size === 0) {
        this.#pendingData.push(data);
      } else {
        for (const listener of this.#dataListeners) {
          listener(data);
        }
      }
    });
    process.onExit((event) => {
      this.#exit = event;
      for (const listener of this.#exitListeners) {
        listener(event);
      }
      this.#exitListeners.clear();
    });
  }

  public onData(listener: (data: string) => void): Disposable {
    this.#dataListeners.add(listener);
    for (const data of this.#pendingData.splice(0)) {
      listener(data);
    }
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  public onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.#exitListeners.add(listener);
    const exit = this.#exit;
    if (exit !== undefined) {
      queueMicrotask(() => {
        if (this.#exitListeners.delete(listener)) {
          listener(exit);
        }
      });
    }
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  public write(data: string): void {
    this.#process.write(data);
  }

  public resize(cols: number, rows: number): void {
    this.#process.resize(cols, rows);
  }

  public kill(): void {
    this.#process.kill();
  }
}

export class NodePtyFactory implements PtyFactoryPort {
  public spawn(launchSpec: AgentLaunchSpec, size: TerminalSize): PtyProcessPort {
    if (launchSpec.shell) {
      throw new RuntimeOperationError(
        "pty.shell-unsupported",
        "The PTY runtime requires a separate executable and argv; shell launch is disabled.",
        false,
      );
    }

    const process = nodePty.spawn(launchSpec.command, [...launchSpec.args], {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: launchSpec.cwd,
      env: { ...launchSpec.env },
      useConpty: true,
    });

    return new BufferedNodePtyProcess(process);
  }
}
