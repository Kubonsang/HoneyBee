import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { RunIdSchema, SessionIdSchema } from "@honeybee/domain";
import {
  createConsoleWebviewHtml,
  isConsoleToExtensionMessage,
  type ConsoleToExtensionMessage,
  type PromptAcknowledgementMessage,
  type PromptSendMessage,
} from "@honeybee/ui-shared";

import type { ConsoleApplicationService } from "../application/console-service.js";
import { postConsoleMessage, type ConsoleMessageTrace } from "./console-message-bridge.js";
import { PromptDeliveryCoordinator } from "./prompt-delivery-coordinator.js";

export class ConsoleViewProvider implements vscode.Disposable {
  readonly #delivery: PromptDeliveryCoordinator;
  readonly #serviceSubscription: { dispose(): void };
  readonly #activeWork = new Set<Promise<void>>();
  #panel: vscode.WebviewPanel | undefined;
  #focusPromptOnReady = false;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly consoleService: ConsoleApplicationService,
    private readonly reportError: (error: unknown) => void,
    private readonly reportDiagnostic: (message: string) => void,
    private readonly terminalTrace: (event: ConsoleMessageTrace) => void = () => undefined,
  ) {
    this.#delivery = new PromptDeliveryCoordinator(consoleService, reportError, reportDiagnostic);
    this.#serviceSubscription = consoleService.onMessage((message) => {
      if (this.#panel !== undefined) {
        void postConsoleMessage(this.#panel.webview, message, this.terminalTrace).catch(
          this.reportError,
        );
      }
    });
  }

  /** Opens the terminal-first Console in an editor-area Webview Panel. */
  public reveal(): void {
    this.openPanel(false);
  }

  /** Opens the Console and expands its Prompt Composer. */
  public composePrompt(): void {
    this.openPanel(true);
  }

  private openPanel(focusPrompt: boolean): void {
    if (this.#shutdownPromise !== undefined) return;
    this.#focusPromptOnReady ||= focusPrompt;
    if (this.#panel !== undefined) {
      this.#panel.reveal(undefined, false);
      if (focusPrompt) {
        void Promise.resolve(this.#panel.webview.postMessage({ type: "prompt.focus" })).catch(
          this.reportError,
        );
        this.#focusPromptOnReady = false;
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "honeyBee.consolePanel",
      "Honey Bee Console",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
      },
    );
    this.#panel = panel;
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "console.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "console.css"),
    );
    webview.html = createConsoleWebviewHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(18).toString("base64"),
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });
    webview.onDidReceiveMessage((message: unknown) => {
      if (!isConsoleToExtensionMessage(message)) {
        this.reportError(new Error("Honey Bee Console sent an invalid message."));
        return;
      }
      this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      if (this.#panel === panel) this.#panel = undefined;
    });
  }

  public dispose(): void {
    void this.shutdown().catch(this.reportError);
  }

  /** Flushes pending Draft and delivery work before releasing the Console subscription. */
  public shutdown(): Promise<void> {
    this.#shutdownPromise ??= (async () => {
      this.#serviceSubscription.dispose();
      await this.#delivery.dispose();
      await Promise.allSettled(this.#activeWork);
      this.#panel?.dispose();
      this.#panel = undefined;
    })();
    return this.#shutdownPromise;
  }

  private handleMessage(message: ConsoleToExtensionMessage): void {
    switch (message.type) {
      case "webview.ready":
        this.consoleService.replayState();
        if (this.#focusPromptOnReady && this.#panel !== undefined) {
          this.#focusPromptOnReady = false;
          void Promise.resolve(this.#panel.webview.postMessage({ type: "prompt.focus" })).catch(
            this.reportError,
          );
        }
        break;
      case "draft.changed":
        this.#delivery.scheduleDraft(SessionIdSchema.parse(message.sessionId), message.content);
        break;
      case "prompt.send":
        this.deliverPrompt(message);
        break;
      case "prompt.recovery.assume-delivered":
        this.run(this.assumeDelivered(message.requestId, SessionIdSchema.parse(message.sessionId)));
        break;
      case "prompt.recovery.retry":
        this.run(this.retryUnknown(message.requestId, SessionIdSchema.parse(message.sessionId)));
        break;
      case "terminal.run.input":
        this.run(
          this.consoleService.sendTerminalInput(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
            message.data,
          ),
        );
        break;
      case "terminal.run.resize":
        this.run(
          this.consoleService.resize(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
            message.columns,
            message.rows,
          ),
        );
        break;
      case "terminal.run.snapshot-request":
        this.run(
          this.consoleService.requestTerminalSnapshot(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
            message.afterSeq,
          ),
        );
        break;
      case "terminal.run.select":
        this.run(
          this.consoleService.selectViewedRun(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
          ),
        );
        break;
      case "terminal.run.follow-active":
        this.run(this.consoleService.followActiveRun(SessionIdSchema.parse(message.sessionId)));
        break;
      case "terminal.run.open-log":
        this.run(
          this.openRunLog(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
          ),
        );
        break;
      case "session.start":
        this.run(this.consoleService.start(SessionIdSchema.parse(message.sessionId)));
        break;
      case "session.interrupt":
        this.run(
          this.consoleService.interrupt(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
          ),
        );
        break;
      case "session.stop":
        this.run(
          this.consoleService.stop(
            SessionIdSchema.parse(message.sessionId),
            RunIdSchema.parse(message.runId),
          ),
        );
        break;
    }
  }

  private async openRunLog(
    sessionId: ReturnType<typeof SessionIdSchema.parse>,
    runId: ReturnType<typeof RunIdSchema.parse>,
  ): Promise<void> {
    try {
      const path = await this.consoleService.resolveRunLogPath(sessionId, runId);
      const uri = vscode.Uri.file(path);
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error("Run log is a directory.");
      if (stat.size > 10 * 1024 * 1024) {
        const choice = await vscode.window.showWarningMessage(
          "This Run log is larger than 10 MiB and may be slow to open.",
          { modal: true },
          "Open log",
        );
        if (choice !== "Open log") return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      this.reportDiagnostic(
        "Run log unavailable for Session " + sessionId + ", Run " + runId + ".",
      );
      await vscode.window.showWarningMessage(
        "Honey Bee could not open this Run log. It may no longer exist.",
      );
    }
  }
  private async assumeDelivered(
    requestId: string,
    sessionId: ReturnType<typeof SessionIdSchema.parse>,
  ): Promise<void> {
    await this.#delivery.flushDraft(sessionId);
    const result = await this.consoleService.assumePromptDelivered(requestId, sessionId);
    if (result.status === "failed") {
      this.reportDiagnostic(
        "Attempt recovery action failed for Session " +
          sessionId +
          ", request " +
          requestId +
          " (" +
          result.code +
          ").",
      );
      await vscode.window.showWarningMessage(
        "Honey Bee could not resolve the unknown Prompt outcome. The Session remains locked.",
      );
    }
  }

  private async retryUnknown(
    requestId: string,
    sessionId: ReturnType<typeof SessionIdSchema.parse>,
  ): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      "The original Prompt may already have reached the Runtime. Retrying can execute it twice.",
      { modal: true },
      "Retry with new request ID",
    );
    if (confirmation !== "Retry with new request ID") return;
    await this.#delivery.flushDraft(sessionId);
    const result = await this.consoleService.retryUnknownPrompt(requestId, sessionId);
    if (result.status === "failed") {
      this.reportDiagnostic(
        "Attempt recovery retry failed for Session " +
          sessionId +
          ", request " +
          requestId +
          " (" +
          result.code +
          ").",
      );
      await vscode.window.showWarningMessage(
        "Honey Bee could not retry this unknown Prompt. Its Draft and Session lock were preserved.",
      );
      return;
    }
    if (result.status === "retry-finished" && result.delivery.status !== "accepted") {
      await vscode.window.showWarningMessage(
        result.delivery.status === "unknown"
          ? "The replacement Prompt outcome is also unknown. Automatic resend remains disabled."
          : "The replacement Prompt was rejected. The original unknown outcome remains unresolved.",
      );
    }
  }

  private deliverPrompt(message: PromptSendMessage): void {
    const parsedMessage = {
      ...message,
      sessionId: SessionIdSchema.parse(message.sessionId),
    };
    this.run(
      this.#delivery.deliver(parsedMessage).then(async (acknowledgement) => {
        await this.postAcknowledgement(acknowledgement);
      }),
    );
  }

  private async postAcknowledgement(
    message: PromptAcknowledgementMessage | undefined,
  ): Promise<void> {
    if (message !== undefined && this.#panel !== undefined) {
      await this.#panel.webview.postMessage(message);
    }
  }

  private run(work: Promise<void>): void {
    const tracked = work.catch(this.reportError);
    this.#activeWork.add(tracked);
    void tracked.finally(() => {
      this.#activeWork.delete(tracked);
    });
  }
}
