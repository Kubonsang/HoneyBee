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
