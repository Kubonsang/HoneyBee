import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  CaretDown,
  CaretRight,
  Code,
  Copy,
  File,
  FileCode,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  Play,
  Robot,
  SpinnerGap,
  TerminalWindow,
  X,
} from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type {
  DesktopAgentProfileV1,
  DesktopProjectFileV1,
  DesktopProjectProfile,
  DesktopProjectTreeEntryV1,
  DesktopPtyKindV1,
  DesktopPtySessionV1,
} from "../shared/ipc.js";

export type WorkbenchTab = "files" | "agent" | "shell" | "work";

interface ProjectWorkbenchProps {
  readonly profile: DesktopProjectProfile;
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly defaultAgentId?: string | undefined;
  readonly terminalFontSize: number;
  readonly tab: WorkbenchTab;
  readonly children: ReactNode;
  onError(message: string): void;
}

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "The Workbench operation failed.";

function FileExplorer({
  profile,
  onError,
}: {
  readonly profile: DesktopProjectProfile;
  onError(message: string): void;
}) {
  const [children, setChildren] = useState<
    Readonly<Record<string, readonly DesktopProjectTreeEntryV1[]>>
  >({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [openFiles, setOpenFiles] = useState<readonly DesktopProjectFileV1[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [loadingPath, setLoadingPath] = useState<string>();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<readonly DesktopProjectTreeEntryV1[]>();

  const loadDirectory = async (relativePath: string): Promise<void> => {
    if (children[relativePath] !== undefined) return;
    setLoadingPath(relativePath);
    try {
      const tree = await window.honeybee.projectTree({
        schemaVersion: 1,
        profileId: profile.profileId,
        relativePath,
      });
      setChildren((current) => ({ ...current, [relativePath]: tree.entries }));
    } catch (error) {
      onError(readableError(error));
    } finally {
      setLoadingPath((current) => (current === relativePath ? undefined : current));
    }
  };

  useEffect(() => {
    setChildren({});
    setExpanded(new Set([""]));
    setOpenFiles([]);
    setSelectedPath(undefined);
    setSearchResults(undefined);
    void loadDirectory("");
    // The profile ID is the scope boundary; loadDirectory intentionally starts a fresh tree.
  }, [profile.profileId]);

  const toggleDirectory = (relativePath: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
    if (!expanded.has(relativePath)) void loadDirectory(relativePath);
  };

  const openFile = async (relativePath: string): Promise<void> => {
    const existing = openFiles.find((file) => file.relativePath === relativePath);
    if (existing !== undefined) {
      setSelectedPath(relativePath);
      return;
    }
    setLoadingPath(relativePath);
    try {
      const file = await window.honeybee.readProjectFile({
        schemaVersion: 1,
        profileId: profile.profileId,
        relativePath,
      });
      setOpenFiles((current) =>
        [...current.filter((entry) => entry.relativePath !== relativePath), file].slice(-8),
      );
      setSelectedPath(relativePath);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setLoadingPath((current) => (current === relativePath ? undefined : current));
    }
  };

  const closeFile = (relativePath: string): void => {
    setOpenFiles((current) => {
      const index = current.findIndex((file) => file.relativePath === relativePath);
      const next = current.filter((file) => file.relativePath !== relativePath);
      if (selectedPath === relativePath) {
        setSelectedPath(next[Math.min(index, next.length - 1)]?.relativePath);
      }
      return next;
    });
  };

  const search = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (query.trim().length === 0) {
      setSearchResults(undefined);
      return;
    }
    setSearching(true);
    try {
      const result = await window.honeybee.searchProject({
        schemaVersion: 1,
        profileId: profile.profileId,
        query: query.trim(),
        maxResults: 100,
      });
      setSearchResults(result.matches);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setSearching(false);
    }
  };

  const renderEntries = (parent: string, depth: number): ReactNode =>
    (children[parent] ?? []).map((entry) => {
      const isExpanded = expanded.has(entry.relativePath);
      return (
        <div key={entry.relativePath}>
          <button
            className={`file-tree-entry ${selectedPath === entry.relativePath ? "selected" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            title={entry.relativePath}
            onClick={() =>
              entry.kind === "directory"
                ? toggleDirectory(entry.relativePath)
                : void openFile(entry.relativePath)
            }
          >
            {entry.kind === "directory" ? (
              <>
                {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
              </>
            ) : (
              <>
                <span className="tree-indent" />
                <FileCode size={15} />
              </>
            )}
            <span>{entry.name}</span>
            {loadingPath === entry.relativePath && <SpinnerGap className="spin-icon" size={12} />}
          </button>
          {entry.kind === "directory" && isExpanded && renderEntries(entry.relativePath, depth + 1)}
        </div>
      );
    });

  const selectedFile = openFiles.find((file) => file.relativePath === selectedPath);
  const visibleEntries = searchResults;

  return (
    <section className="file-workbench">
      <aside className="file-explorer">
        <header>
          <span>EXPLORER</span>
          <strong>{profile.label}</strong>
        </header>
        <form className="file-search" onSubmit={(event) => void search(event)}>
          <MagnifyingGlass size={15} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value.length === 0) setSearchResults(undefined);
            }}
            placeholder="Search files by path"
          />
          {searching && <SpinnerGap className="spin-icon" size={14} />}
        </form>
        <div className="file-tree" aria-label="Project files">
          {visibleEntries === undefined ? (
            renderEntries("", 0)
          ) : visibleEntries.length === 0 ? (
            <p>No matching files.</p>
          ) : (
            visibleEntries.map((entry) => (
              <button
                className="file-search-result"
                key={entry.relativePath}
                onClick={() =>
                  entry.kind === "file"
                    ? void openFile(entry.relativePath)
                    : toggleDirectory(entry.relativePath)
                }
              >
                {entry.kind === "file" ? <File size={15} /> : <Folder size={15} />}
                <span>{entry.relativePath}</span>
              </button>
            ))
          )}
        </div>
      </aside>
      <div className="file-editor">
        <nav className="editor-tabs" aria-label="Open files">
          {openFiles.map((file) => (
            <button
              className={file.relativePath === selectedPath ? "selected" : ""}
              key={file.relativePath}
              onClick={() => setSelectedPath(file.relativePath)}
            >
              <FileCode size={14} />
              <span>{file.relativePath.split("/").at(-1)}</span>
              <i
                role="button"
                tabIndex={0}
                aria-label={`Close ${file.relativePath}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeFile(file.relativePath);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") closeFile(file.relativePath);
                }}
              >
                <X size={12} />
              </i>
            </button>
          ))}
        </nav>
        {selectedFile === undefined ? (
          <div className="editor-empty">
            <Code size={38} weight="duotone" />
            <h2>Read project files without leaving HoneyBee</h2>
            <p>
              Select a text file from the Explorer. Editing stays with your Agent or external IDE.
            </p>
          </div>
        ) : (
          <article className="code-preview">
            <header>
              <span title={selectedFile.relativePath}>{selectedFile.relativePath}</span>
              <small>
                {selectedFile.language} · {selectedFile.byteLength.toLocaleString()} bytes
                {selectedFile.truncated ? " · preview truncated" : ""}
              </small>
            </header>
            <pre aria-label={`Read-only source ${selectedFile.relativePath}`}>
              {selectedFile.content.split("\n").map((line, index) => (
                <span className="code-line" key={index}>
                  <i>{index + 1}</i>
                  <code>{line || " "}</code>
                </span>
              ))}
            </pre>
          </article>
        )}
      </div>
    </section>
  );
}

function InteractiveTerminal({
  profile,
  agents,
  defaultAgentId,
  initialKind,
  terminalFontSize,
  onError,
}: {
  readonly profile: DesktopProjectProfile;
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly defaultAgentId?: string | undefined;
  readonly initialKind: DesktopPtyKindV1;
  readonly terminalFontSize: number;
  onError(message: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const sessionRef = useRef<DesktopPtySessionV1 | undefined>(undefined);
  const mountedRef = useRef(true);
  const cursorRef = useRef(0);
  const [kind, setKind] = useState<DesktopPtyKindV1>(initialKind);
  const [agentId, setAgentId] = useState(defaultAgentId ?? agents[0]?.agentId ?? "");
  const [session, setSession] = useState<DesktopPtySessionV1>();
  const [starting, setStarting] = useState(false);

  useEffect(() => setKind(initialKind), [initialKind]);
  useEffect(() => {
    if (agents.some((agent) => agent.agentId === agentId)) return;
    setAgentId(defaultAgentId ?? agents[0]?.agentId ?? "");
  }, [agentId, agents, defaultAgentId]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      disableStdin: false,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: terminalFontSize,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: {
        background: "#070b0e",
        foreground: "#d7dee2",
        cursor: "#f2bf49",
        selectionBackground: "#6f5c2766",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      const active = sessionRef.current;
      if (active === undefined) return;
      void window.honeybee
        .writePty({ schemaVersion: 1, sessionId: active.sessionId, data })
        .catch((error: unknown) => onError(readableError(error)));
    });
    const resizeTerminal = (): void => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const active = sessionRef.current;
      if (active !== undefined) {
        void window.honeybee.resizePty({
          schemaVersion: 1,
          sessionId: active.sessionId,
          columns: terminal.cols,
          rows: terminal.rows,
        });
      }
    };
    const resize = new ResizeObserver(resizeTerminal);
    resize.observe(host);
    requestAnimationFrame(resizeTerminal);
    terminal.writeln("\u001b[38;2;242;191;73mHoneyBee interactive terminal\u001b[0m");
    terminal.writeln("Start a native Agent CLI or project PowerShell session.\r\n");
    return () => {
      input.dispose();
      resize.disconnect();
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
    };
  }, [onError, terminalFontSize]);

  useEffect(() => {
    sessionRef.current = session;
    if (session === undefined) return;
    cursorRef.current = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await window.honeybee.ptySnapshot({
          schemaVersion: 1,
          sessionId: session.sessionId,
          afterCursor: cursorRef.current,
        });
        if (stopped) return;
        cursorRef.current = snapshot.cursor;
        for (const chunk of snapshot.chunks) terminalRef.current?.write(chunk.data);
        setSession(snapshot.session);
        if (snapshot.session.state === "running") timer = setTimeout(() => void poll(), 100);
      } catch (error) {
        if (!stopped) onError(readableError(error));
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [onError, session?.sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = sessionRef.current;
      if (active !== undefined) {
        void window.honeybee.closePty({ schemaVersion: 1, sessionId: active.sessionId });
      }
    };
  }, []);

  const start = async (): Promise<void> => {
    if (kind === "agent" && agentId.length === 0) {
      onError("Choose a connected Agent before opening its native CLI.");
      return;
    }
    setStarting(true);
    try {
      const active = sessionRef.current;
      if (active !== undefined) {
        await window.honeybee.closePty({ schemaVersion: 1, sessionId: active.sessionId });
      }
      terminalRef.current?.clear();
      terminalRef.current?.writeln(
        `\u001b[38;2;242;191;73mStarting ${kind === "agent" ? "native Agent CLI" : "project PowerShell"}…\u001b[0m`,
      );
      try {
        fitRef.current?.fit();
      } catch {
        // Hidden terminals use the conservative initial size below.
      }
      const next = await window.honeybee.createPty({
        schemaVersion: 1,
        profileId: profile.profileId,
        kind,
        ...(kind === "agent" ? { agentId } : {}),
        columns: Math.max(20, terminalRef.current?.cols ?? 100),
        rows: Math.max(5, terminalRef.current?.rows ?? 30),
      });
      if (!mountedRef.current) {
        await window.honeybee.closePty({ schemaVersion: 1, sessionId: next.sessionId });
        return;
      }
      sessionRef.current = next;
      setSession(next);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="interactive-terminal">
      <header>
        <div className="terminal-launcher">
          <div className="segmented-control">
            <button className={kind === "agent" ? "selected" : ""} onClick={() => setKind("agent")}>
              <Robot size={15} /> Agent CLI
            </button>
            <button className={kind === "shell" ? "selected" : ""} onClick={() => setKind("shell")}>
              <TerminalWindow size={15} /> PowerShell
            </button>
          </div>
          {kind === "agent" && (
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">Choose Agent</option>
              {agents.map((agent) => (
                <option value={agent.agentId} key={agent.agentId}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          )}
          <button className="primary" disabled={starting} onClick={() => void start()}>
            {starting ? (
              <SpinnerGap className="spin-icon" size={15} />
            ) : (
              <Play size={15} weight="fill" />
            )}
            {session === undefined ? "Start terminal" : "Restart"}
          </button>
        </div>
        <div className="terminal-session-meta">
          <i className={session?.state === "running" ? "live" : ""} />
          <span>
            {session === undefined ? "No session" : `${session.label} · ${session.state}`}
          </span>
          <button
            className="icon-button"
            title="Copy selected text"
            onClick={() =>
              void navigator.clipboard.writeText(terminalRef.current?.getSelection() ?? "")
            }
          >
            <Copy size={15} />
          </button>
        </div>
      </header>
      <div
        className="interactive-terminal-host"
        ref={hostRef}
        aria-label="Interactive project terminal"
      />
    </section>
  );
}

export function ProjectWorkbench({
  profile,
  agents,
  defaultAgentId,
  terminalFontSize,
  tab,
  children,
  onError,
}: ProjectWorkbenchProps) {
  return (
    <section className="project-workbench">
      <div className={`workbench-stage workbench-${tab}`}>
        {tab === "files" ? (
          <FileExplorer profile={profile} onError={onError} />
        ) : tab === "agent" || tab === "shell" ? (
          <InteractiveTerminal
            key={tab}
            profile={profile}
            agents={agents}
            defaultAgentId={defaultAgentId}
            initialKind={tab}
            terminalFontSize={terminalFontSize}
            onError={onError}
          />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function WorkbenchTabs({
  tab,
  onTab,
}: {
  readonly tab: WorkbenchTab;
  onTab(tab: WorkbenchTab): void;
}) {
  const items = [
    ["files", "Files", <FileCode size={16} />],
    ["agent", "Agent CLI", <Robot size={16} />],
    ["shell", "Shell", <TerminalWindow size={16} />],
  ] as const;
  return (
    <nav className="workbench-tabs" aria-label="Workbench resources">
      {items.map(([value, label, icon]) => (
        <button
          className={tab === value ? "selected" : ""}
          key={value}
          onClick={() => onTab(value)}
        >
          {icon}
          {label}
        </button>
      ))}
    </nav>
  );
}
