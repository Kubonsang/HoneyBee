import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  terminals: [] as unknown[],
  fitAddons: [] as unknown[],
}));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    public readonly buffer = {
      active: { length: 1, baseY: 0, viewportY: 0 },
    };
    public readonly writes: string[] = [];
    public readonly openedHidden: boolean[] = [];
    public readonly refreshes: { start: number; end: number }[] = [];
    public readonly focus = vi.fn();
    public readonly reset = vi.fn();
    public readonly dispose = vi.fn();
    public cols = 80;
    public rows = 24;

    public constructor() {
      mocks.terminals.push(this);
    }

    public loadAddon(): void {}

    public open(container: HTMLElement): void {
      this.openedHidden.push(container.hidden);
    }

    public onData(): { dispose(): void } {
      return { dispose: vi.fn() };
    }

    public write(data: string, callback?: () => void): void {
      this.writes.push(data);
      this.buffer.active.length += 1;
      callback?.();
    }

    public refresh(start: number, end: number): void {
      this.refreshes.push({ start, end });
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FakeFitAddon {
    public readonly fit = vi.fn();

    public constructor() {
      mocks.fitAddons.push(this);
    }
  }
  return { FitAddon: FakeFitAddon };
});

import { XtermTerminalSurfaceFactory } from "./xterm-terminal-surface.js";

interface FakeTerminalState {
  readonly buffer: {
    readonly active: {
      readonly length: number;
      readonly baseY: number;
      readonly viewportY: number;
    };
  };
  readonly writes: readonly string[];
  readonly openedHidden: readonly boolean[];
  readonly refreshes: readonly { readonly start: number; readonly end: number }[];
}

afterEach(() => {
  mocks.terminals.length = 0;
  mocks.fitAddons.length = 0;
  vi.unstubAllGlobals();
});

describe("XtermTerminalSurfaceFactory", () => {
  it("opens xterm only after its Run surface is visible and reports parsed buffer metrics", () => {
    const container = {
      className: "",
      dataset: {} as Record<string, string>,
      hidden: false,
      remove: vi.fn(),
    } as unknown as HTMLDivElement;
    const appendedHidden: boolean[] = [];
    const host = {
      append: (element: HTMLDivElement) => appendedHidden.push(element.hidden),
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      createElement: () => container,
    });

    const surface = new XtermTerminalSurfaceFactory(host).create(
      { sessionId: "session-a", runId: "run-a" },
      vi.fn(),
    );
    const terminal = mocks.terminals[0] as FakeTerminalState;
    expect(appendedHidden).toEqual([true]);
    expect(terminal.openedHidden).toEqual([]);

    const parsedBeforeOpen = vi.fn();
    surface.write("SESSION-A", parsedBeforeOpen);
    expect(terminal.writes).toEqual(["SESSION-A"]);
    expect(terminal.openedHidden).toEqual([]);
    expect(parsedBeforeOpen).toHaveBeenCalledWith({
      bufferLineCount: 2,
      baseY: 0,
      viewportY: 0,
      rows: 24,
    });

    surface.setVisible(true);
    expect(terminal.openedHidden).toEqual([false]);
    expect(surface.fit()).toEqual({ columns: 80, rows: 24 });

    const parsedVisible = vi.fn();
    surface.write("SESSION-B", parsedVisible);
    expect(terminal.writes).toEqual(["SESSION-A", "SESSION-B"]);
    expect(parsedVisible).toHaveBeenCalledWith({
      bufferLineCount: 3,
      baseY: 0,
      viewportY: 0,
      rows: 24,
    });
    expect(terminal.refreshes.at(-1)).toEqual({ start: 0, end: 23 });

    surface.setVisible(false);
    surface.setVisible(true);
    expect(terminal.openedHidden).toEqual([false]);
  });
});
