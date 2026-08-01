import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";

import type { TerminalRunKey } from "../contracts.js";
import type {
  TerminalDimensions,
  TerminalRenderMetrics,
  TerminalSurface,
  TerminalSurfaceFactory,
} from "./terminal-run-registry.js";

const terminalTheme: ITheme = {
  background: "#11100d",
  foreground: "#eee8d5",
  cursor: "#f4c95d",
  cursorAccent: "#11100d",
  selectionBackground: "#6d582f99",
  black: "#171510",
  brightBlack: "#686153",
  red: "#ff7a7a",
  brightRed: "#ff9b9b",
  green: "#9dd68c",
  brightGreen: "#b4e7a5",
  yellow: "#f4c95d",
  brightYellow: "#ffe090",
  blue: "#78a9ff",
  brightBlue: "#9ec1ff",
  magenta: "#c99bea",
  brightMagenta: "#ddb8f3",
  cyan: "#71c7c1",
  brightCyan: "#91ddd8",
  white: "#e2ddcf",
  brightWhite: "#fffdf5",
};

const terminalOptions: ITerminalOptions = {
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "bar",
  fontFamily:
    "var(--vscode-editor-font-family, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace)",
  fontSize: 12,
  scrollback: 10_000,
  theme: terminalTheme,
};

class XtermTerminalSurface implements TerminalSurface {
  readonly #terminal: Terminal;
  readonly #fitAddon: FitAddon;
  readonly #container: HTMLDivElement;
  readonly #dataSubscription: { dispose(): void };
  #opened = false;
  #disposed = false;

  public constructor(host: HTMLElement, key: TerminalRunKey, onData: (data: string) => void) {
    this.#container = document.createElement("div");
    this.#container.className = "terminal-run-surface";
    this.#container.dataset.sessionId = key.sessionId;
    this.#container.dataset.runId = key.runId;
    this.#container.hidden = true;
    host.append(this.#container);

    this.#terminal = new Terminal(terminalOptions);
    this.#fitAddon = new FitAddon();
    this.#terminal.loadAddon(this.#fitAddon);
    this.#dataSubscription = this.#terminal.onData(onData);
  }

  public write(data: string, onParsed?: (metrics: TerminalRenderMetrics) => void): void {
    if (this.#disposed) return;
    this.#terminal.write(data, () => {
      if (this.#disposed) return;
      this.#refreshVisibleRows();
      const active = this.#terminal.buffer.active;
      onParsed?.({
        bufferLineCount: active.length,
        baseY: active.baseY,
        viewportY: active.viewportY,
        rows: this.#terminal.rows,
      });
    });
  }

  public reset(): void {
    if (!this.#disposed) this.#terminal.reset();
  }

  public setVisible(visible: boolean): void {
    if (this.#disposed) return;
    this.#container.hidden = !visible;
    if (visible) this.#ensureOpen();
  }

  public fit(): TerminalDimensions | undefined {
    if (this.#disposed || this.#container.hidden) return undefined;
    this.#ensureOpen();
    try {
      this.#fitAddon.fit();
      this.#refreshVisibleRows();
      return { columns: this.#terminal.cols, rows: this.#terminal.rows };
    } catch {
      return undefined;
    }
  }

  public focus(): void {
    if (!this.#disposed && !this.#container.hidden) {
      this.#ensureOpen();
      this.#terminal.focus();
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dataSubscription.dispose();
    this.#terminal.dispose();
    this.#container.remove();
  }

  #ensureOpen(): void {
    if (this.#opened || this.#disposed) return;
    this.#terminal.open(this.#container);
    this.#opened = true;
  }

  #refreshVisibleRows(): void {
    if (!this.#opened || this.#container.hidden || this.#terminal.rows <= 0) return;
    this.#terminal.refresh(0, this.#terminal.rows - 1);
  }
}

/** Creates one xterm emulator and FitAddon pair for each Session Run. */
export class XtermTerminalSurfaceFactory implements TerminalSurfaceFactory {
  public constructor(private readonly host: HTMLElement) {}

  public create(key: TerminalRunKey, onData: (data: string) => void): TerminalSurface {
    return new XtermTerminalSurface(this.host, key, onData);
  }
}
