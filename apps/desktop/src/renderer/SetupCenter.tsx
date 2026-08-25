import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  FolderOpen,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  XCircle,
} from "@phosphor-icons/react";

import {
  DesktopSetupDraftV1Schema,
  type DesktopProjectProfileV2,
  type DesktopSetupDiscoveryV1,
  type DesktopSetupStatusV1,
} from "../shared/ipc.js";

interface SetupCenterProps {
  readonly onComplete: (profile: DesktopProjectProfileV2) => void;
  readonly onError: (message: string) => void;
}

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "Setup operation failed.";

export function SetupCenter({ onComplete, onError }: SetupCenterProps) {
  const [discovery, setDiscovery] = useState<DesktopSetupDiscoveryV1>();
  const [status, setStatus] = useState<DesktopSetupStatusV1>();
  const [busy, setBusy] = useState<"discover" | "start" | "import">();
  const [label, setLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [unityPath, setUnityPath] = useState("");
  const [testplayPath, setTestplayPath] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [bridgePath, setBridgePath] = useState("");
  const [validationEnabled, setValidationEnabled] = useState(false);
  const [agentPath, setAgentPath] = useState("");
  const [agentArgs, setAgentArgs] = useState("");
  const [editorCapacity, setEditorCapacity] = useState(2);

  useEffect(() => {
    if (status?.state !== "running") return;
    let stopped = false;
    const timer = setInterval(() => {
      void window.honeybee
        .setupStatus({ schemaVersion: 1, setupId: status.setupId })
        .then((next) => {
          if (stopped) return;
          setStatus(next);
          if (next.state === "completed" && next.profile !== undefined) onComplete(next.profile);
        })
        .catch((error: unknown) => {
          if (!stopped) onError(readableError(error));
        });
    }, 750);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [onComplete, onError, status?.setupId, status?.state]);

  const loadDiscovery = async (selectedProject: string): Promise<void> => {
    setBusy("discover");
    try {
      const next = await window.honeybee.discoverSetup({
        schemaVersion: 1,
        projectPath: selectedProject,
      });
      setDiscovery(next);
      setProjectPath(next.projectPath);
      setLabel(next.projectPath.split(/[\\/]/u).at(-1) ?? "Unity project");
      setUnityPath(next.unity[0]?.path ?? "");
      setStoragePath(next.workspaceStorage[0]?.path ?? "");
      setAgentPath(next.agents[0]?.path ?? "");
      setTestplayPath("");
      setBridgePath("");
      setValidationEnabled(false);
      setWorkspaceRoot(next.suggestedWorkspaceRoot);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const choose = async (
    kind: Parameters<typeof window.honeybee.chooseSetupPath>[0]["kind"],
    update: (value: string) => void,
  ): Promise<void> => {
    try {
      const selected = await window.honeybee.chooseSetupPath({ schemaVersion: 1, kind });
      if (selected !== null) update(selected);
    } catch (error) {
      onError(readableError(error));
    }
  };

  const chooseProject = async (): Promise<void> => {
    const selected = await window.honeybee.chooseSetupPath({ schemaVersion: 1, kind: "project" });
    if (selected !== null) await loadDiscovery(selected);
  };

  const valid = useMemo(
    () =>
      DesktopSetupDraftV1Schema.safeParse({
        schemaVersion: 1,
        label,
        projectPath,
        unityPath,
        ...(validationEnabled ? { testplayPath } : {}),
        workspaceStoragePath: storagePath,
        workspaceRoot,
        ...(validationEnabled ? { bridgeOverlayPath: bridgePath } : {}),
        agent: {
          command: agentPath,
          ...(agentArgs.trim().length === 0 ? {} : { args: agentArgs.trim().split(/\s+/u) }),
        },
        editorCapacity,
      }).success,
    [
      agentArgs,
      agentPath,
      bridgePath,
      editorCapacity,
      label,
      projectPath,
      storagePath,
      testplayPath,
      unityPath,
      validationEnabled,
      workspaceRoot,
    ],
  );

  const start = async (): Promise<void> => {
    setBusy("start");
    try {
      await window.honeybee.installSetupStorage({
        schemaVersion: 1,
        workspaceRoot,
      });
      const draft = DesktopSetupDraftV1Schema.parse({
        schemaVersion: 1,
        label,
        projectPath,
        unityPath,
        ...(validationEnabled ? { testplayPath } : {}),
        workspaceStoragePath: storagePath,
        workspaceRoot,
        ...(validationEnabled ? { bridgeOverlayPath: bridgePath } : {}),
        agent: {
          command: agentPath,
          ...(agentArgs.trim().length === 0 ? {} : { args: agentArgs.trim().split(/\s+/u) }),
        },
        editorCapacity,
      });
      setStatus(await window.honeybee.startSetup(draft));
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const importProfile = async (): Promise<void> => {
    setBusy("import");
    try {
      const profile = await window.honeybee.importSetup();
      if (profile !== null) onComplete(profile);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="setup-center">
      <div className="setup-hero panel">
        <div>
          <span className="eyebrow">LOCAL MANAGED SETUP</span>
          <h2>Prepare HoneyBee once, then keep building.</h2>
          <p>
            Setup Center pins your local tools, provisions one reusable Library parent, and keeps
            the TestPlay Bridge inside isolated workspaces. Your source project is never modified.
          </p>
        </div>
        <div className="setup-hero-actions">
          <button
            className="secondary"
            onClick={() => void importProfile()}
            disabled={busy !== undefined}
          >
            <DownloadSimple size={17} /> Import profile
          </button>
          <button
            className="primary"
            onClick={() => void chooseProject()}
            disabled={busy !== undefined}
          >
            <FolderOpen size={17} /> {busy === "discover" ? "Inspecting…" : "Choose project"}
          </button>
        </div>
      </div>

      <div className="setup-grid">
        <div className="setup-form panel">
          <div className="section-title compact">
            <div>
              <span className="eyebrow">ENVIRONMENT PROFILE</span>
              <h2>Detected tools</h2>
            </div>
            {discovery !== undefined && (
              <span className="health good">UNITY {discovery.projectVersion}</span>
            )}
          </div>
          <SetupField label="Profile name" value={label} onChange={setLabel} />
          <SetupField
            label="Unity project"
            value={projectPath}
            onChange={setProjectPath}
            onBrowse={() => void chooseProject()}
          />
          <SetupField
            label="Unity Editor"
            value={unityPath}
            onChange={setUnityPath}
            onBrowse={() => void choose("unity", setUnityPath)}
          />
          <SetupField
            label="Bundled workspace-storage"
            value={storagePath}
            onChange={setStoragePath}
            readOnly
          />
          <SetupField
            label="Workspace root"
            value={workspaceRoot}
            onChange={setWorkspaceRoot}
            onBrowse={() => void choose("workspace-root", setWorkspaceRoot)}
          />
          <label className="setup-capacity">
            <span>
              <input
                type="checkbox"
                checked={validationEnabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setValidationEnabled(enabled);
                  if (enabled) {
                    setTestplayPath(discovery?.testplay[0]?.path ?? "");
                    setBridgePath(discovery?.bridgeOverlays[0]?.path ?? "");
                  } else {
                    setTestplayPath("");
                    setBridgePath("");
                  }
                }}
              />{" "}
              Enable TestPlay compile / warm-test
            </span>
            <small>Optional. Agent-only verified patch Work does not require TestPlay.</small>
          </label>
          {validationEnabled && (
            <>
              <SetupField
                label="TestPlay"
                value={testplayPath}
                onChange={setTestplayPath}
                onBrowse={() => void choose("testplay", setTestplayPath)}
              />
              <SetupField
                label="Bridge package overlay"
                value={bridgePath}
                onChange={setBridgePath}
                onBrowse={() => void choose("bridge-overlay", setBridgePath)}
              />
            </>
          )}
          <div className="setup-pair">
            <SetupField
              label="Agent executable"
              value={agentPath}
              onChange={setAgentPath}
              onBrowse={() => void choose("agent", setAgentPath)}
            />
            <SetupField
              label="Agent arguments"
              value={agentArgs}
              onChange={setAgentArgs}
              placeholder="optional"
            />
          </div>
          <label className="setup-capacity">
            <span>Editor pool capacity</span>
            <input
              type="number"
              min={1}
              max={8}
              value={editorCapacity}
              onChange={(event) => setEditorCapacity(Number(event.target.value))}
            />
            <small>Used only by optional compile and warm-test capabilities.</small>
          </label>
          <button
            className="primary setup-run"
            disabled={!valid || busy !== undefined || status?.state === "running"}
            onClick={() => void start()}
          >
            <Play size={17} weight="fill" />{" "}
            {busy === "start" ? "Installing & preparing…" : "Install & prepare environment"}
          </button>
        </div>

        <aside className="setup-summary panel">
          <div className="section-title compact">
            <div>
              <span className="eyebrow">READINESS</span>
              <h2>What HoneyBee manages</h2>
            </div>
          </div>
          <SetupFact
            icon={<ShieldCheck size={19} />}
            title="Source stays immutable"
            body="Assets are copied only into storage-owned staging and isolated Workspaces."
          />
          <SetupFact
            icon={<SlidersHorizontal size={19} />}
            title="Stable parent reuse"
            body="Assets are excluded from the compatibility key; optional Bridge identity is included only when TestPlay validation is enabled."
          />
          <SetupFact
            icon={<Wrench size={19} />}
            title="Pinned local tools"
            body="workspace-storage ships with HoneyBee. Selected executables and optional Bridge files are pinned in the managed profile."
          />
          {status !== undefined && (
            <div className={`setup-progress ${status.state}`}>
              {status.state === "completed" ? (
                <CheckCircle size={22} weight="fill" />
              ) : status.state === "failed" ? (
                <XCircle size={22} weight="fill" />
              ) : (
                <ArrowClockwise size={22} />
              )}
              <div>
                <strong>{status.phase}</strong>
                <p>{status.message}</p>
              </div>
              {status.state === "running" && (
                <button
                  className="text-button"
                  onClick={() =>
                    void window.honeybee
                      .cancelSetup({ schemaVersion: 1, setupId: status.setupId })
                      .then(setStatus)
                  }
                >
                  Cancel
                </button>
              )}
              {status.state === "recovery-required" && (
                <button
                  className="secondary"
                  onClick={() =>
                    void window.honeybee
                      .resumeSetup({ schemaVersion: 1, setupId: status.setupId })
                      .then(setStatus)
                  }
                >
                  Resume cleanup
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function SetupField(
  props: Readonly<{
    label: string;
    value: string;
    onChange: (value: string) => void;
    onBrowse?: () => void;
    placeholder?: string;
    readOnly?: boolean;
  }>,
) {
  return (
    <label className="setup-field">
      <span>{props.label}</span>
      <div>
        <input
          value={props.value}
          placeholder={props.placeholder}
          readOnly={props.readOnly}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {props.onBrowse !== undefined && (
          <button onClick={props.onBrowse} aria-label={`Browse ${props.label}`}>
            <FolderOpen size={16} />
          </button>
        )}
      </div>
    </label>
  );
}

function SetupFact(props: Readonly<{ icon: React.ReactNode; title: string; body: string }>) {
  return (
    <div className="setup-fact">
      <span>{props.icon}</span>
      <div>
        <strong>{props.title}</strong>
        <p>{props.body}</p>
      </div>
    </div>
  );
}
