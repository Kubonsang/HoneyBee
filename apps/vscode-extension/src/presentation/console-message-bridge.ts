import type { ExtensionToConsoleMessage } from "@honeybee/ui-shared";

export interface ConsoleMessagePort {
  postMessage(message: ExtensionToConsoleMessage): Thenable<boolean>;
}

export interface ConsoleMessageTrace {
  readonly stage: "post-requested" | "post-settled";
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly delivered?: boolean;
}

/**
 * Posts one Console message and traces terminal delivery without retaining terminal content.
 */
export const postConsoleMessage = async (
  port: ConsoleMessagePort,
  message: ExtensionToConsoleMessage,
  trace: (event: ConsoleMessageTrace) => void = () => undefined,
): Promise<boolean> => {
  if (message.type === "terminal.run.data") {
    trace({
      stage: "post-requested",
      sessionId: message.sessionId,
      runId: message.runId,
      sequence: message.seq,
    });
  }
  const delivered = await port.postMessage(message);
  if (message.type === "terminal.run.data") {
    trace({
      stage: "post-settled",
      sessionId: message.sessionId,
      runId: message.runId,
      sequence: message.seq,
      delivered,
    });
  }
  return delivered;
};

/**
 * Owns one FIFO chain for a Webview generation so state, Run open, and data messages settle
 * in enqueue order. A failed post does not poison later queued messages.
 */
export class ConsoleMessageQueue {
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  public constructor(
    private readonly port: ConsoleMessagePort,
    private readonly trace: (event: ConsoleMessageTrace) => void = () => undefined,
  ) {}

  public post(message: ExtensionToConsoleMessage): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    const result = this.#tail.then(async () => postConsoleMessage(this.port, message, this.trace));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
  }
}
