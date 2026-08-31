import type { ReactNode } from "react";
import {
  ArrowLeft,
  ClockCounterClockwise,
  FolderSimple,
  Gear,
  GitBranch,
  Hexagon,
  MapTrifold,
  Plus,
  Robot,
  SquaresFour,
  TerminalWindow,
  Wrench,
} from "@phosphor-icons/react";

import type { DesktopProjectProfile } from "../shared/ipc.js";

export type DesktopShellMode = "hub" | "project";
export type DesktopView =
  | "workspace"
  | "work-map"
  | "runs"
  | "worktrees"
  | "project"
  | "projects"
  | "setup"
  | "agents"
  | "settings";

interface DesktopShellProps {
  readonly mode: DesktopShellMode;
  readonly view: DesktopView;
  readonly profile?: DesktopProjectProfile | undefined;
  readonly runCount: number;
  readonly activeRunCount: number;
  readonly runtimeVersion?: string | undefined;
  readonly children: ReactNode;
  readonly onView: (view: DesktopView) => void;
  readonly onHub: () => void;
  readonly onNewWork: () => void;
}

interface RailItem {
  readonly view: DesktopView;
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge?: number | undefined;
}

export function DesktopShell({
  mode,
  view,
  profile,
  runCount,
  activeRunCount,
  runtimeVersion,
  children,
  onView,
  onHub,
  onNewWork,
}: DesktopShellProps) {
  const hubItems: readonly RailItem[] = [
    { view: "projects", label: "Projects", icon: <FolderSimple size={21} /> },
    { view: "agents", label: "Agents", icon: <Robot size={21} /> },
  ];
  const projectItems: readonly RailItem[] = [
    { view: "workspace", label: "Workbench", icon: <TerminalWindow size={21} /> },
    { view: "work-map", label: "Work Map", icon: <MapTrifold size={21} /> },
    { view: "runs", label: "Runs", icon: <ClockCounterClockwise size={21} />, badge: runCount },
    { view: "worktrees", label: "Worktrees", icon: <GitBranch size={21} /> },
    { view: "project", label: "Project", icon: <Wrench size={21} /> },
  ];
  const items = mode === "project" ? projectItems : hubItems;

  return (
    <div className={`desktop-shell shell-${mode}`}>
      <aside
        className="activity-rail"
        aria-label={mode === "project" ? "Project views" : "HoneyBee views"}
      >
        <button
          className="rail-brand"
          onClick={mode === "project" ? onHub : () => onView("projects")}
          title={mode === "project" ? "Back to Projects" : "HoneyBee Projects"}
        >
          {mode === "project" ? <ArrowLeft size={21} /> : <Hexagon size={25} weight="duotone" />}
          <span>{mode === "project" ? "Projects" : "HoneyBee"}</span>
        </button>

        <nav className="rail-navigation">
          {items.map((item) => (
            <button
              key={item.view}
              className={view === item.view ? "selected" : ""}
              onClick={() => onView(item.view)}
              aria-current={view === item.view ? "page" : undefined}
              title={item.label}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.badge !== undefined && item.badge > 0 && <em>{item.badge}</em>}
            </button>
          ))}
        </nav>

        <div className="rail-spacer" />
        {mode === "project" && (
          <button className="rail-new-work" onClick={onNewWork} title="New Work">
            <Plus size={21} weight="bold" />
            <span>New Work</span>
          </button>
        )}
        <button
          className={view === "settings" ? "selected" : ""}
          onClick={() => onView("settings")}
          title="Settings"
        >
          <Gear size={21} />
          <span>Settings</span>
        </button>
      </aside>

      <section className="shell-stage">
        <header className="shell-titlebar">
          <div className="shell-project-identity">
            {mode === "project" ? (
              <SquaresFour size={18} weight="duotone" />
            ) : (
              <Hexagon size={18} weight="duotone" />
            )}
            <span>
              <strong>{profile?.label ?? "HoneyBee Desktop"}</strong>
              <small>{profile?.projectPath ?? "Choose one Unity project to begin."}</small>
            </span>
          </div>
          <div className="shell-runtime-status">
            {activeRunCount > 0 && <span className="active-run-chip">{activeRunCount} active</span>}
            <i className="live-dot" />
            <span>HoneyBee {runtimeVersion ?? "…"}</span>
          </div>
        </header>
        <main className={`shell-content view-${view}`}>{children}</main>
      </section>
    </div>
  );
}
