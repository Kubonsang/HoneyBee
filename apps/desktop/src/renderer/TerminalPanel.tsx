import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Copy, TerminalWindow } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type {
  DesktopTerminalEntryV1,
  DesktopTerminalModeV1,
  DesktopTerminalSnapshotV1,
} from "../shared/ipc.js";

interface TerminalPanelProps {
  readonly runId: string;
  readonly standalone?: boolean;
  onError?(message: string): void;
}

const colors: Readonly<Record<DesktopTerminalEntryV1["channel"], string>> = {
  system: "\u001b[38;2;135;145;151m",
  assistant: "\u001b[38;2;224;228;230m",
  tool: "\u001b[38;2;242;191;73m",
  approval: "\u001b[38;2;255;210;96m",
  stderr: "\u001b[38;2;244;105;101m",
  raw: "\u001b[38;2;112;199;129m",
};
const reset = "\u001b[0m";

const visibleProviderText = (value: string): string => {
  let result = "";
  for (const character of value.replaceAll("\r\n", "\n")) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") {
      result += character;
    } else if (
      code < 32 ||
      code === 127 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      result +=
        code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16)}`;
    } else {
      result += character;
    }
  }
  return result;
};

const terminalText = (entry: DesktopTerminalEntryV1): string => {
  const text = visibleProviderText(entry.text).replaceAll("\n", "\r\n");
  if (entry.channel === "assistant") return `${colors.assistant}${text}${reset}`;
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const direction =
    entry.mode === "raw"
      ? entry.direction === "honeybee"
        ? " → "
        : entry.direction === "provider"
          ? " ← "
          : " ↔ "
      : " ";
  return `${colors[entry.channel]}[${time}] [${entry.stepId}] ${entry.channel}${direction}${text}${reset}\r\n`;
};

export function TerminalPanel({ runId, standalone = false, onError }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const cursorRef = useRef(0);
  const instanceRef = useRef<string | undefined>(undefined);
  const copiedTextRef = useRef("");
  const followTailRef = useRef(true);
  const [mode, setMode] = useState<DesktopTerminalModeV1>("readable");
  const [state, setState] = useState<DesktopTerminalSnapshotV1["state"]>("running");
  const [followTail, setFollowTail] = useState(true);
  const [rawEnabled, setRawEnabled] = useState(false);
  const [rawAvailable, setRawAvailable] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    followTailRef.current = followTail;
  }, [followTail]);

  useEffect(() => {
    let stopped = false;
    const refresh = async (): Promise<void> => {
      try {
        const settings = await window.honeybee.developerSettings();
        if (stopped) return;
        setRawEnabled(settings.rawAgentProtocolEnabled);
        if (!settings.rawAgentProtocolEnabled) {
          setMode((current) => (current === "raw" ? "readable" : current));
        }
      } catch (error) {
        if (!stopped) {
          onError?.(error instanceof Error ? error.message : "Could not read Developer Settings.");
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [onError]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: standalone ? 13 : 11,
      lineHeight: 1.35,
      scrollback: 5_000,
      theme: {
        background: "#070b0e",
        foreground: "#d7dee2",
        cursor: "#070b0e",
        selectionBackground: "#6f5c274d",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    const fitTerminal = (): void => {
      if (terminalRef.current !== terminal) return;
      try {
        fit.fit();
      } catch {
        // A hidden or StrictMode-disposed terminal may not have renderer dimensions yet.
      }
    };
    const resize = new ResizeObserver(fitTerminal);
    resize.observe(host);
    requestAnimationFrame(fitTerminal);
    return () => {
      resize.disconnect();
      terminal.dispose();
      terminalRef.current = undefined;
    };
  }, [standalone]);

  useEffect(() => {
    cursorRef.current = 0;
    instanceRef.current = undefined;
    const resetTerminal = (): void => {
      copiedTextRef.current = "";
      terminalRef.current?.clear();
      terminalRef.current?.write(
        `\u001b[38;2;242;191;73mHoneyBee Live CLI · ${runId.slice(0, 8)} · ${mode}\u001b[0m\r\n`,
      );
    };
    resetTerminal();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await window.honeybee.terminalSnapshot({
          schemaVersion: 1,
          runId,
          afterCursor: cursorRef.current,
          mode,
        });
        if (stopped) return;
        if (instanceRef.current !== undefined && instanceRef.current !== snapshot.instanceId) {
          instanceRef.current = snapshot.instanceId;
          cursorRef.current = 0;
          resetTerminal();
          timer = setTimeout(() => void poll(), 0);
          return;
        }
        instanceRef.current = snapshot.instanceId;
        cursorRef.current = snapshot.cursor;
        setState(snapshot.state);
        setRawAvailable(snapshot.rawAvailable);
        setTruncated(snapshot.truncated);
        for (const entry of snapshot.entries) {
          const text = terminalText(entry);
          const plainText = [...Object.values(colors), reset].reduce(
            (value, control) => value.replaceAll(control, ""),
            text,
          );
          copiedTextRef.current = (copiedTextRef.current + plainText).slice(-2 * 1024 * 1024);
          terminalRef.current?.write(text);
        }
        if (followTailRef.current && snapshot.entries.length > 0) {
          terminalRef.current?.scrollToBottom();
        }
        timer = setTimeout(() => void poll(), snapshot.state === "running" ? 250 : 1_000);
      } catch (error) {
        if (stopped) return;
        onError?.(error instanceof Error ? error.message : "Live CLI polling failed.");
        timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [mode, onError, runId]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(copiedTextRef.current);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Could not copy terminal output.");
    }
  };

  const openWindow = async (): Promise<void> => {
    try {
      await window.honeybee.openTerminalWindow({ schemaVersion: 1, runId });
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Could not open the Terminal window.");
    }
  };

  return (
    <section className={`terminal-panel ${standalone ? "standalone" : ""}`}>
      <header>
        <div className="terminal-title">
          <TerminalWindow size={18} />
          <span>
            <strong>Live CLI</strong>
            <small>
              Run {runId.slice(0, 8)} · {state}
            </small>
          </span>
          <i className={`terminal-state ${state}`} />
        </div>
        <div className="terminal-actions">
          <div className="segmented-control">
            <button
              className={mode === "readable" ? "selected" : ""}
              onClick={() => setMode("readable")}
            >
              Readable
            </button>
            <button
              className={mode === "raw" ? "selected" : ""}
              disabled={!rawEnabled}
              title={
                rawEnabled
                  ? "Show raw JSON-RPC"
                  : "Enable Raw Agent Protocol in Developer Settings first."
              }
              onClick={() => setMode("raw")}
            >
              Raw
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              checked={followTail}
              onChange={(event) => setFollowTail(event.target.checked)}
            />
            Follow
          </label>
          <button className="icon-button" onClick={() => void copy()} title="Copy terminal output">
            <Copy size={16} />
          </button>
          {!standalone && (
            <button className="secondary" onClick={() => void openWindow()}>
              <ArrowSquareOut size={16} /> Open in window
            </button>
          )}
        </div>
      </header>
      {!rawEnabled && mode === "readable" && (
        <p className="terminal-privacy">
          Raw JSON-RPC is hidden. Enable it in Settings only when protocol diagnostics are needed.
        </p>
      )}
      {rawEnabled && !rawAvailable && mode === "raw" && (
        <p className="terminal-privacy">No Raw protocol messages are available for this Run yet.</p>
      )}
      {truncated && (
        <p className="terminal-privacy warning">
          Older lines were discarded after reaching the local Live CLI memory limit.
        </p>
      )}
      <div className="terminal-host" ref={hostRef} aria-label="Read-only Agent terminal output" />
    </section>
  );
}

export function TerminalWindowApp() {
  const parameters = new URLSearchParams(window.location.search);
  const runId = parameters.get("runId");
  const [error, setError] = useState<string>();
  if (runId === null) return <main className="terminal-window-error">Run ID is missing.</main>;
  return (
    <main className="terminal-window-shell">
      <TerminalPanel runId={runId} standalone onError={setError} />
      {error !== undefined && <div className="terminal-window-error">{error}</div>}
    </main>
  );
}
