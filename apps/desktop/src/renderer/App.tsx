import { ArrowLeft, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DesktopApiError,
  type DesktopDoctorReportV1,
  type DesktopProjectCandidateV1,
  type DesktopProjectInspectionV1,
  type DesktopProjectV2,
  type DesktopWorkspaceCreateRequestV1,
  type DesktopWorkspaceV2,
} from "../shared/ipc.js";
import { AppFrame } from "./components/AppFrame.js";
import { CloneProject } from "./components/CloneProject.js";
import { ProjectHome } from "./components/ProjectHome.js";
import { ProjectPicker } from "./components/ProjectPicker.js";
import { ProjectSetup } from "./components/ProjectSetup.js";
import { WorkspaceDialog } from "./components/WorkspaceDialog.js";
import { WorkspaceWorkbench } from "./components/WorkspaceWorkbench.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import { selectInitialProject } from "./navigation.js";

type Route = "loading" | "home" | "picker" | "clone" | "setup" | "workbench";
const RECENT_PROJECT_KEY = "honeybee.desktop.recent-project.v1";
const LOCALE_KEY = "honeybee.desktop.locale.v1";

const initialLocale = (): Locale => {
  const saved = localStorage.getItem(LOCALE_KEY);
  if (saved === "ko" || saved === "en") return saved;
  return navigator.language.toLocaleLowerCase().startsWith("ko") ? "ko" : "en";
};

export function App() {
  const initialized = useRef(false);
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  const [route, setRoute] = useState<Route>("loading");
  const [projects, setProjects] = useState<readonly DesktopProjectV2[]>([]);
  const [candidates, setCandidates] = useState<readonly DesktopProjectCandidateV1[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<readonly DesktopWorkspaceV2[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [inspection, setInspection] = useState<DesktopProjectInspectionV1>();
  const [doctor, setDoctor] = useState<DesktopDoctorReportV1>();
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; remediation: readonly string[] }>();
  const project = projects.find((item) => item.projectId === projectId);
  const t = useCallback((key: MessageKey) => message(locale, key), [locale]);

  const setLocale = (next: Locale): void => {
    localStorage.setItem(LOCALE_KEY, next);
    updateLocale(next);
  };
  const reportError = (reason: unknown): void => {
    if (reason instanceof DesktopApiError)
      setError({ message: reason.message, remediation: reason.remediation });
    else
      setError({
        message: reason instanceof Error ? reason.message : String(reason),
        remediation: [],
      });
  };
  const run = (operation: () => Promise<void>): void => {
    setBusy(true);
    setError(undefined);
    void operation()
      .catch(reportError)
      .finally(() => setBusy(false));
  };

  const refreshProjects = useCallback(async (): Promise<readonly DesktopProjectV2[]> => {
    const next = await window.honeybee.projects();
    setProjects(next);
    return next;
  }, []);
  const refreshWorkspaces = useCallback(
    async (selectedProject = projectId): Promise<void> => {
      if (selectedProject === undefined) return;
      const next = await window.honeybee.workspaces({ projectId: selectedProject });
      setWorkspaces(next);
      setWorkspaceId((current) =>
        current !== undefined && next.some((item) => item.workspaceId === current)
          ? current
          : next[0]?.workspaceId,
      );
    },
    [projectId],
  );
  const openProject = useCallback(
    (selected: DesktopProjectV2): void => {
      localStorage.setItem(RECENT_PROJECT_KEY, selected.projectId);
      setProjectId(selected.projectId);
      setRoute("workbench");
      void refreshWorkspaces(selected.projectId).catch(reportError);
    },
    [refreshWorkspaces],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void window.honeybee
      .projects()
      .then(async (next) => {
        setProjects(next);
        if (next.length === 0) {
          setRoute("home");
          return;
        }
        const selected = selectInitialProject(next, localStorage.getItem(RECENT_PROJECT_KEY));
        if (selected !== undefined) {
          localStorage.setItem(RECENT_PROJECT_KEY, selected.projectId);
          setProjectId(selected.projectId);
          const nextWorkspaces = await window.honeybee.workspaces({
            projectId: selected.projectId,
          });
          setWorkspaces(nextWorkspaces);
          setWorkspaceId(nextWorkspaces[0]?.workspaceId);
          setRoute("workbench");
        } else setRoute("picker");
      })
      .catch((reason: unknown) => {
        reportError(reason);
        setRoute("home");
      });
  }, []);

  useEffect(() => {
    if (route !== "workbench" || projectId === undefined) return;
    const refresh = (): void => {
      if (document.visibilityState === "visible")
        void refreshWorkspaces(projectId).catch(reportError);
    };
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [projectId, refreshWorkspaces, route]);

  const showPicker = (): void => {
    run(async () => {
      setCandidates(await window.honeybee.projectCandidates());
      setRoute("picker");
    });
  };
  const inspectPath = (selectedPath: string): void => {
    run(async () => {
      const [nextInspection, nextDoctor] = await Promise.all([
        window.honeybee.inspectProject({ path: selectedPath }),
        window.honeybee.doctor(),
      ]);
      setInspection(nextInspection);
      setDoctor(nextDoctor);
      setWorkspaceRoot(nextInspection.defaultWorkspaceRoot);
      setRoute("setup");
    });
  };
  const chooseCandidate = (candidate: DesktopProjectCandidateV1): void => {
    const registered =
      candidate.registeredProjectId === null
        ? undefined
        : projects.find((item) => item.projectId === candidate.registeredProjectId);
    if (registered?.cacheState === "ready") openProject(registered);
    else inspectPath(candidate.path);
  };
  const browseProject = (): void => {
    run(async () => {
      const selected = await window.honeybee.pickFolder({ kind: "unity-project" });
      if (selected !== null) {
        const [nextInspection, nextDoctor] = await Promise.all([
          window.honeybee.inspectProject({ path: selected }),
          window.honeybee.doctor(),
        ]);
        setInspection(nextInspection);
        setDoctor(nextDoctor);
        setWorkspaceRoot(nextInspection.defaultWorkspaceRoot);
        setRoute("setup");
      }
    });
  };
  const cloneProject = (url: string, destination: string): void => {
    run(async () => {
      const cloned = await window.honeybee.cloneProject({ url, destination });
      const [nextInspection, nextDoctor] = await Promise.all([
        window.honeybee.inspectProject({ path: cloned.path }),
        window.honeybee.doctor(),
      ]);
      setInspection(nextInspection);
      setDoctor(nextDoctor);
      setWorkspaceRoot(nextInspection.defaultWorkspaceRoot);
      setRoute("setup");
    });
  };
  const checkSetup = (): void => {
    if (inspection !== undefined) inspectPath(inspection.path);
  };
  const setupProject = (): void => {
    if (inspection === undefined) return;
    run(async () => {
      const setup = await window.honeybee.setupProject({
        path: inspection.path,
        workspaceRoot: workspaceRoot.trim(),
        label: inspection.label,
      });
      const next = await refreshProjects();
      const selected = next.find((item) => item.projectId === setup.projectId) ?? setup;
      openProject(selected);
    });
  };
  const createWorkspace = (request: DesktopWorkspaceCreateRequestV1): void => {
    run(async () => {
      const created = await window.honeybee.createWorkspace(request);
      setDialogOpen(false);
      await refreshWorkspaces(request.projectId);
      setWorkspaceId(created.workspaceId);
    });
  };
  const openSettings = (): void => {
    if (project === undefined) return;
    inspectPath(project.unityProjectPath);
  };
  const cacheReady = useMemo(
    () =>
      inspection?.registeredProjectId !== null &&
      projects.find((item) => item.projectId === inspection?.registeredProjectId)?.cacheState ===
        "ready",
    [inspection, projects],
  );

  const backTarget =
    route === "picker" || route === "clone"
      ? "home"
      : route === "setup"
        ? projects.length > 0
          ? "picker"
          : "home"
        : undefined;
  return (
    <AppFrame locale={locale} setLocale={setLocale} t={t}>
      {error !== undefined && (
        <div className="error-banner">
          <Warning size={20} weight="fill" />
          <div>
            <strong>{error.message}</strong>
            {error.remediation.map((item) => (
              <small key={item}>{item}</small>
            ))}
          </div>
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      )}
      {backTarget !== undefined && (
        <button
          className="back-button"
          onClick={() => {
            if (backTarget === "home") setRoute("home");
            else showPicker();
          }}
        >
          <ArrowLeft size={19} />
          {t("back")}
        </button>
      )}
      {route === "loading" && (
        <div className="loading-screen">
          <span className="spinner large" />
          <p>HoneyBee</p>
        </div>
      )}
      {route === "home" && (
        <ProjectHome onHub={showPicker} onClone={() => setRoute("clone")} t={t} />
      )}
      {route === "picker" && (
        <ProjectPicker
          candidates={candidates}
          onChoose={chooseCandidate}
          onBrowse={browseProject}
          t={t}
        />
      )}
      {route === "clone" && (
        <CloneProject
          busy={busy}
          onBrowse={(childName) =>
            window.honeybee.pickFolder({
              kind: "clone-destination",
              ...(childName === undefined ? {} : { childName }),
            })
          }
          onClone={cloneProject}
          t={t}
        />
      )}
      {route === "setup" && inspection !== undefined && (
        <ProjectSetup
          inspection={inspection}
          doctor={doctor}
          workspaceRoot={workspaceRoot}
          setWorkspaceRoot={setWorkspaceRoot}
          busy={busy}
          cacheReady={cacheReady === true}
          onBrowseRoot={() =>
            run(async () => {
              const selected = await window.honeybee.pickFolder({
                kind: "workspace-root",
                defaultPath: workspaceRoot,
              });
              if (selected !== null) setWorkspaceRoot(selected);
            })
          }
          onCheck={checkSetup}
          onOpenUnity={() =>
            run(async () => {
              await window.honeybee.launchProjectUnity({ path: inspection.path });
            })
          }
          onSetup={setupProject}
          t={t}
        />
      )}
      {route === "workbench" && project !== undefined && (
        <WorkspaceWorkbench
          project={project}
          workspaces={workspaces}
          workspaceId={workspaceId}
          setWorkspaceId={setWorkspaceId}
          busy={busy}
          onCreate={() => setDialogOpen(true)}
          onSwitchProject={showPicker}
          onSettings={openSettings}
          onRefresh={() => refreshWorkspaces(project.projectId)}
          run={run}
          t={t}
        />
      )}
      {dialogOpen && project !== undefined && (
        <WorkspaceDialog
          projectId={project.projectId}
          busy={busy}
          onClose={() => setDialogOpen(false)}
          onCreate={createWorkspace}
          t={t}
        />
      )}
    </AppFrame>
  );
}
