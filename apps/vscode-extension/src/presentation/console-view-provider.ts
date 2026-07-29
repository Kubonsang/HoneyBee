import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { SessionIdSchema, type SessionId } from "@honeybee/domain";
import {
  createConsoleWebviewHtml,
  isConsoleToExtensionMessage,
  type ConsoleToExtensionMessage,
} from "@honeybee/ui-shared";

import type { ConsoleApplicationService } from "../application/console-service.js";

interface PendingDraft {
  readonly content: string;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class ConsoleViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly #pendingDrafts = new Map<SessionId, PendingDraft>();
  readonly #serviceSubscription: { dispose(): void };
  #view: vscode.WebviewView | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly consoleService: ConsoleApplicationService,
    private readonly reportError: (error: unknown) => void,
  ) {
    this.#serviceSubscription = consoleService.onMessage((message) => {
      this.#view?.webview.postMessage(message);
    });
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    const scriptUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "console.js"),
    );
    const styleUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "console.css"),
    );
    view.webview.html = createConsoleWebviewHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(18).toString("base64"),
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isConsoleToExtensionMessage(message)) {
        this.reportError(new Error("Honey Bee Console sent an invalid message."));
        return;
      }
      this.handleMessage(message);
    });
    view.onDidDispose(() => {
      this.#view = undefined;
    });
  }

  public reveal(): void {
    this.#view?.show(true);
    this.#view?.webview.postMessage({ type: "prompt.focus" });
  }

  public dispose(): void {
    this.#serviceSubscription.dispose();
    for (const [sessionId] of this.#pendingDrafts) {
      this.flushDraft(sessionId);
    }
    this.#pendingDrafts.clear();
  }

  private handleMessage(message: ConsoleToExtensionMessage): void {
    switch (message.type) {
      case "webview.ready":
        this.consoleService.replayState();
        break;
      case "draft.changed":
        this.scheduleDraft(SessionIdSchema.parse(message.sessionId), message.content);
        break;
      case "prompt.send":
        this.run(
          this.consoleService.sendPrompt(SessionIdSchema.parse(message.sessionId), message.content),
        );
        break;
      case "terminal.input":
        this.run(
          this.consoleService.sendTerminalInput(
            SessionIdSchema.parse(message.sessionId),
            message.data,
          ),
        );
        break;
      case "terminal.resize":
        this.run(
          this.consoleService.resize(
            SessionIdSchema.parse(message.sessionId),
            message.columns,
            message.rows,
          ),
        );
        break;
      case "session.start":
        this.run(this.consoleService.start(SessionIdSchema.parse(message.sessionId)));
        break;
      case "session.interrupt":
        this.run(this.consoleService.interrupt(SessionIdSchema.parse(message.sessionId)));
        break;
      case "session.stop":
        this.run(this.consoleService.stop(SessionIdSchema.parse(message.sessionId)));
        break;
    }
  }

  private scheduleDraft(sessionId: SessionId, content: string): void {
    const current = this.#pendingDrafts.get(sessionId);
    if (current !== undefined) {
      clearTimeout(current.timeout);
    }
    const timeout = setTimeout(() => {
      this.flushDraft(sessionId);
    }, 250);
    this.#pendingDrafts.set(sessionId, { content, timeout });
  }

  private flushDraft(sessionId: SessionId): void {
    const pending = this.#pendingDrafts.get(sessionId);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pendingDrafts.delete(sessionId);
    this.run(this.consoleService.saveDraft(sessionId, pending.content));
  }

  private run(work: Promise<void>): void {
    work.catch(this.reportError);
  }
}
