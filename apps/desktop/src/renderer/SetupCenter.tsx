import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  FolderOpen,
  Play,
  ShieldCheck,
  Sparkle,
  Wrench,
  XCircle,
} from "@phosphor-icons/react";

import {
  DesktopProjectAddRequestV2Schema,
  type ComponentManagerSnapshotV1,
  type DesktopAgentProfileV1,
  type DesktopProjectDiscoveryV1,
  type DesktopProjectProfile,
  type DesktopSetupStatusV1,
} from "../shared/ipc.js";

interface SetupCenterProps {
  readonly onComplete: (profile: DesktopProjectProfile) => void;
  readonly onError: (message: string) => void;
  readonly initialProfile?: DesktopProjectProfile;
  readonly initialProjectPath?: string;
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly preferredAgentId?: string;
  readonly onManageAgents: () => void;
}

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "Project setup failed.";

export function SetupCenter({
  onComplete,
  onError,
  initialProfile,
  initialProjectPath,
  agents,
  preferredAgentId,
  onManageAgents,
}: SetupCenterProps) {
  const managed =
    initialProfile?.schemaVersion === 2 || initialProfile?.schemaVersion === 3
      ? initialProfile.environment
      : undefined;
  const [discovery, setDiscovery] = useState<DesktopProjectDiscoveryV1>();
  const [components, setComponents] = useState<ComponentManagerSnapshotV1>();
  const [status, setStatus] = useState<DesktopSetupStatusV1>();
  const [busy, setBusy] = useState<"discover" | "start" | "import" | "install-testplay">();
  const [localPhase, setLocalPhase] = useState<string>();
  const [projectPath, setProjectPath] = useState(
    initialProfile?.projectPath ?? initialProjectPath ?? "",
  );
  const [unityPath, setUnityPath] = useState(managed?.unity.path ?? "");
  const [agentId, setAgentId] = useState(
    preferredAgentId ?? agents.find((agent) => agent.enabled)?.agentId ?? "",
  );
  const [testplayVersion, setTestplayVersion] = useState(
    initialProfile?.schemaVersion === 3 ? (initialProfile.environment.testplay?.version ?? "") : "",
  );

  useEffect(() => {
    void window.honeybee
      .components()
      .then(setComponents)
      .catch((error: unknown) => {
        onError(readableError(error));
      });
  }, [onError]);

  useEffect(() => {
    if (status?.state !== "running") return;
    let stopped = false;
    const timer = setInterval(() => {
      void window.honeybee
        .setupStatus({ schemaVersion: 1, setupId: status.setupId })
        .then((next) => {
          if (stopped) return;
          setStatus(next);
          setLocalPhase(undefined);
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

  const loadProject = async (selectedProject: string): Promise<void> => {
    setBusy("discover");
    setLocalPhase("Checking project and local tools…");
    try {
      const [next, componentState] = await Promise.all([
        window.honeybee.discoverProject({ schemaVersion: 1, projectPath: selectedProject }),
        window.honeybee.components(),
      ]);
      setDiscovery(next);
      setComponents(componentState);
      setProjectPath(next.projectPath);
      setUnityPath(next.unity[0]?.path ?? "");
      setTestplayVersion("");
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
      setLocalPhase(undefined);
    }
  };

  useEffect(() => {
    if (initialProfile !== undefined || initialProjectPath === undefined || discovery !== undefined)
      return;
    void loadProject(initialProjectPath);
  }, [discovery, initialProfile, initialProjectPath]);

  const choose = async (
    kind: "project" | "unity",
    update: (value: string) => void,
  ): Promise<void> => {
    try {
      const selected = await window.honeybee.chooseSetupPath({ schemaVersion: 1, kind });
      if (selected === null) return;
      if (kind === "project") await loadProject(selected);
      else update(selected);
    } catch (error) {
      onError(readableError(error));
    }
  };

  const valid = useMemo(
    () =>
      DesktopProjectAddRequestV2Schema.safeParse({
        schemaVersion: 2,
        projectPath,
        unityPath,
        preferredAgentId: agentId,
        ...(testplayVersion.length === 0 ? {} : { testplayVersion }),
      }).success,
    [agentId, projectPath, testplayVersion, unityPath],
  );

  const addProject = async (): Promise<void> => {
    setBusy("start");
    setLocalPhase(
      "Preparing isolated workspace… Windows may ask once for permission to install the local storage service.",
    );
    try {
      const request = DesktopProjectAddRequestV2Schema.parse({
        schemaVersion: 2,
        projectPath,
        unityPath,
        preferredAgentId: agentId,
        ...(testplayVersion.length === 0 ? {} : { testplayVersion }),
      });
      setStatus(await window.honeybee.addProject(request));
      setLocalPhase("Preparing Unity cache…");
    } catch (error) {
      setLocalPhase(undefined);
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

  const testplayReleases =
    components?.releases.filter((release) => release.componentId === "testplay") ?? [];
  const installedTestplayVersions = new Set(
    components?.installed
      .filter((receipt) => receipt.componentId === "testplay")
      .map((receipt) => receipt.version) ?? [],
  );
  const installTestplay = async (version: string): Promise<void> => {
    setBusy("install-testplay");
    try {
      await window.honeybee.installComponent({
        schemaVersion: 1,
        componentId: "testplay",
        version,
        approved: true,
      });
      setComponents(await window.honeybee.components());
      setTestplayVersion(version);
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
          <span className="eyebrow">
            {initialProfile === undefined ? "ADD UNITY PROJECT" : "PROJECT SETTINGS"}
          </span>
          <h2>
            {initialProfile === undefined
              ? "Choose a project. HoneyBee prepares the rest."
              : `Update ${initialProfile.label}'s environment.`}
          </h2>
          <p>
            Select Unity once. Agent connections are managed globally and this project only keeps a
            changeable default preference.
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
            onClick={() => void choose("project", setProjectPath)}
            disabled={busy !== undefined}
          >
            <FolderOpen size={17} /> {busy === "discover" ? "Inspecting…" : "Add project"}
          </button>
        </div>
      </div>

      <div className="setup-grid">
        <div className="setup-form panel">
          <div className="section-title compact">
            <div>
              <span className="eyebrow">ENVIRONMENT PROFILE</span>
              <h2>Project tools</h2>
            </div>
            {discovery !== undefined && (
              <span className="health good">UNITY {discovery.projectVersion ?? "DETECTED"}</span>
            )}
          </div>
          <SetupField
            label="Unity project"
            value={projectPath}
            onChange={setProjectPath}
            onBrowse={() => void choose("project", setProjectPath)}
            readOnly
          />
          <SetupField
            label="Unity Editor"
            value={unityPath}
            onChange={setUnityPath}
            onBrowse={() => void choose("unity", setUnityPath)}
          />
          <label className="setup-field">
            <span>Preferred Agent</span>
            <div>
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                <option value="">Choose a connected Agent</option>
                {agents
                  .filter((agent) => agent.enabled)
                  .map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.displayName} · {agent.provider}
                    </option>
                  ))}
              </select>
              <button type="button" onClick={onManageAgents} aria-label="Manage Agents">
                <Wrench size={16} />
              </button>
            </div>
          </label>
          {agents.length === 0 && (
            <div className="setup-addon-note">
              Connect at least one Agent first. Agent accounts and commands are shared across
              projects, never owned by one project.
            </div>
          )}

          <label className="setup-field">
            <span>TestPlay validation add-on (optional)</span>
            <div>
              <select
                value={testplayVersion}
                onChange={(event) => setTestplayVersion(event.target.value)}
              >
                <option value="">Not installed · patch integrity only</option>
                {[...installedTestplayVersions].map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </select>
            </div>
          </label>
          {testplayReleases.length === 0 && (
            <div className="setup-addon-note">
              No compatible TestPlay release is currently published. Compile and warm-test will be
              shown as not run; workspace and patch integrity remain verified.
            </div>
          )}
          {testplayReleases
            .filter((release) => !installedTestplayVersions.has(release.version))
            .map((release) => (
              <button
                key={release.version}
                className="secondary"
                disabled={busy !== undefined}
                onClick={() => void installTestplay(release.version)}
              >
                <DownloadSimple size={17} /> Install TestPlay {release.version}
              </button>
            ))}

          <button
            className="primary setup-run"
            disabled={!valid || busy !== undefined || status?.state === "running"}
            onClick={() => void addProject()}
          >
            <Play size={17} weight="fill" />
            {busy === "start" ? "Preparing project…" : "Add to HoneyBee"}
          </button>
        </div>

        <aside className="setup-summary panel">
          <div className="section-title compact">
            <div>
              <span className="eyebrow">AUTOMATIC SETUP</span>
              <h2>What happens next</h2>
            </div>
          </div>
          <SetupFact
            icon={<ShieldCheck size={19} />}
            title="Original project stays untouched"
            body="HoneyBee prepares the Library parent and every Work in storage-owned isolation."
          />
          <SetupFact
            icon={<Wrench size={19} />}
            title="Storage is managed for you"
            body="The signed-in Windows user may approve one service installation. There are no roots or versions to choose."
          />
          <SetupFact
            icon={<Sparkle size={19} />}
            title="Project ready"
            body="After Unity builds the reusable cache, this project opens directly in Command Center."
          />
          {(localPhase !== undefined || status !== undefined) && (
            <div className={`setup-progress ${status?.state ?? "running"}`}>
              {status?.state === "completed" ? (
                <CheckCircle size={22} weight="fill" />
              ) : status?.state === "failed" ? (
                <XCircle size={22} weight="fill" />
              ) : (
                <ArrowClockwise size={22} />
              )}
              <div>
                <strong>{status?.phase ?? "Checking environment"}</strong>
                <p>{localPhase ?? status?.message}</p>
              </div>
              {status?.state === "running" && (
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
              {status?.state === "recovery-required" && (
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
