import { useState } from "react";
import { ArrowClockwise, Link, Plus, Robot, Trash, Wrench } from "@phosphor-icons/react";

import type {
  DesktopAgentProfileV1,
  DesktopAgentProviderV1,
  DesktopAgentStatusV1,
  DesktopAgentUpsertRequestV1,
} from "../shared/ipc.js";

interface AgentManagerViewProps {
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly statuses: readonly DesktopAgentStatusV1[];
  readonly onChange: () => Promise<void>;
  readonly onError: (message: string) => void;
  readonly onNotice: (message: string) => void;
}

const defaults = (provider: DesktopAgentProviderV1) =>
  provider === "codex"
    ? {
        name: "Codex",
        command: "codex",
        args: "exec --sandbox workspace-write --ephemeral --skip-git-repo-check -",
      }
    : provider === "claude"
      ? { name: "Claude Code", command: "claude", args: "-p --output-format text" }
      : provider === "opencode"
        ? { name: "OpenCode", command: "opencode", args: "run --pure" }
        : { name: "Custom Agent", command: "", args: "" };

type AgentAdapter = DesktopAgentProfileV1["adapter"];

const sessionDefaults = (provider: DesktopAgentProviderV1, adapter: AgentAdapter) => {
  if (adapter === "codex-app-server-v1") {
    return { command: "codex", args: "--disable plugins app-server --stdio" };
  }
  if (adapter === "opencode-acp-v1") {
    return { command: "opencode", args: "acp" };
  }
  const legacy = defaults(provider);
  return { command: legacy.command, args: legacy.args };
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Agent operation failed.";

export function AgentManagerView({
  agents,
  statuses,
  onChange,
  onError,
  onNotice,
}: AgentManagerViewProps) {
  const [provider, setProvider] = useState<DesktopAgentProviderV1>("codex");
  const [adapter, setAdapter] = useState<AgentAdapter>("stdio-framed-v2");
  const [displayName, setDisplayName] = useState(defaults("codex").name);
  const [command, setCommand] = useState(defaults("codex").command);
  const [args, setArgs] = useState(defaults("codex").args);
  const [payloadPaths, setPayloadPaths] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const selectProvider = (value: DesktopAgentProviderV1): void => {
    const next = defaults(value);
    setProvider(value);
    setAdapter("stdio-framed-v2");
    setDisplayName(next.name);
    setCommand(next.command);
    setArgs(next.args);
    setPayloadPaths("");
    setEditingId(undefined);
  };

  const save = async (): Promise<void> => {
    setBusy("save");
    try {
      const request: DesktopAgentUpsertRequestV1 = {
        schemaVersion: 1,
        ...(editingId === undefined ? {} : { agentId: editingId }),
        displayName: displayName.trim(),
        provider,
        adapter,
        command: {
          command: command.trim(),
          ...(args.trim().length === 0 ? {} : { args: args.trim().split(/\s+/u) }),
        },
        ...(payloadPaths.trim().length === 0
          ? {}
          : {
              payloadPaths: payloadPaths
                .split(/\r?\n/u)
                .map((value) => value.trim())
                .filter(Boolean),
            }),
        enabled: true,
      };
      await window.honeybee.upsertAgent(request);
      await onChange();
      onNotice(`${request.displayName} saved to the global Agent Library.`);
      selectProvider(provider);
    } catch (error) {
      onError(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const action = async (agent: DesktopAgentProfileV1, kind: "probe" | "connect" | "remove") => {
    setBusy(`${kind}:${agent.agentId}`);
    try {
      if (kind === "remove") {
        await window.honeybee.removeAgent({ schemaVersion: 1, agentId: agent.agentId });
        onNotice(`${agent.displayName} removed. Existing Runs keep their durable snapshot.`);
      } else if (kind === "connect") {
        const result = await window.honeybee.connectAgent({
          schemaVersion: 1,
          agentId: agent.agentId,
        });
        onNotice(result.message);
      } else {
        const result = await window.honeybee.probeAgent({
          schemaVersion: 1,
          agentId: agent.agentId,
        });
        onNotice(result.summary);
      }
      await onChange();
    } catch (error) {
      onError(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="agent-manager">
      <div className="agent-intro panel">
        <div>
          <span className="eyebrow">GLOBAL AGENT LIBRARY</span>
          <h2>Connect once. Choose per Work.</h2>
          <p>
            Projects keep only a default preference. Provider credentials stay in each official CLI;
            HoneyBee stores command profiles and readiness only.
          </p>
        </div>
        <Robot size={44} weight="duotone" />
      </div>

      <div className="agent-layout">
        <div className="agent-list">
          {agents.length === 0 && (
            <div className="panel runtime-empty">
              <Robot size={38} weight="duotone" />
              <h2>No connected Agents</h2>
              <p>Add Codex, Claude Code, OpenCode, or a compatible framed CLI.</p>
            </div>
          )}
          {agents.map((agent) => {
            const status = statuses.find((entry) => entry.agentId === agent.agentId);
            return (
              <article className="agent-card panel" key={agent.agentId}>
                <div className="agent-card-head">
                  <span className="project-glyph">
                    <Robot size={20} weight="duotone" />
                  </span>
                  <div>
                    <h3>{agent.displayName}</h3>
                    <p>
                      {agent.provider} ·{" "}
                      {agent.adapter === "stdio-framed-v2" ? "Legacy" : "Experimental session"} ·{" "}
                      {status?.version ?? "version pending"}
                    </p>
                  </div>
                  <span className={`agent-state ${status?.status ?? "probe-failed"}`}>
                    {status?.status ?? "unchecked"}
                  </span>
                </div>
                <code title={agent.command.command}>{agent.command.command}</code>
                <p>{status?.summary ?? "Run a bounded readiness probe."}</p>
                <div className="agent-actions">
                  <button
                    className="secondary"
                    onClick={() => void action(agent, "probe")}
                    disabled={busy !== undefined}
                  >
                    <ArrowClockwise size={15} /> Test
                  </button>
                  {agent.provider !== "custom" && (
                    <button
                      className="secondary"
                      onClick={() => void action(agent, "connect")}
                      disabled={busy !== undefined}
                    >
                      <Link size={15} /> Connect
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditingId(agent.agentId);
                      setProvider(agent.provider);
                      setAdapter(agent.adapter);
                      setDisplayName(agent.displayName);
                      setCommand(agent.command.command);
                      setArgs(agent.command.args?.join(" ") ?? "");
                      setPayloadPaths(
                        agent.trust?.files
                          .filter((file) => file.role === "payload")
                          .map((file) => file.path)
                          .join("\n") ?? "",
                      );
                    }}
                  >
                    <Wrench size={15} /> Edit
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() => void action(agent, "remove")}
                    disabled={busy !== undefined}
                  >
                    <Trash size={15} /> Remove
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        <aside className="agent-form panel">
          <span className="eyebrow">{editingId === undefined ? "ADD AGENT" : "EDIT AGENT"}</span>
          <h2>Execution profile</h2>
          <label>
            <span>Provider</span>
            <select
              value={provider}
              onChange={(event) => selectProvider(event.target.value as DesktopAgentProviderV1)}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
              <option value="opencode">OpenCode</option>
              <option value="custom">Custom framed CLI</option>
            </select>
          </label>
          <label>
            <span>Name</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            <span>Adapter</span>
            <select
              value={adapter}
              onChange={(event) => {
                const next = event.target.value as AgentAdapter;
                setAdapter(next);
                const launch = sessionDefaults(provider, next);
                setCommand(launch.command);
                setArgs(launch.args);
              }}
            >
              <option value="stdio-framed-v2">Legacy batch (stable)</option>
              {provider === "codex" && (
                <option value="codex-app-server-v1">Codex app-server (Experimental)</option>
              )}
              {provider === "opencode" && (
                <option value="opencode-acp-v1">OpenCode ACP (Experimental)</option>
              )}
            </select>
          </label>
          <label>
            <span>Executable</span>
            <input value={command} onChange={(event) => setCommand(event.target.value)} />
          </label>
          <label>
            <span>Arguments</span>
            <input
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="optional model and runtime flags"
            />
          </label>
          {provider === "custom" && (
            <label>
              <span>Trusted payload files</span>
              <textarea
                value={payloadPaths}
                onChange={(event) => setPayloadPaths(event.target.value)}
                placeholder={
                  "One absolute script or payload path per line\nLeave empty for a native executable"
                }
                rows={4}
              />
            </label>
          )}
          <p className="hint">
            Saving approves hashes for the executable and resolved launch payloads. HoneyBee blocks
            execution if they change. Secrets and API keys must not be entered here.
          </p>
          {adapter !== "stdio-framed-v2" && (
            <p className="hint">
              Experimental sessions expose root tool approval and Skill observation. Plan, resume,
              steer, plugins, structured questions, and subagent approval remain unavailable.
            </p>
          )}
          <button
            className="primary wide"
            onClick={() => void save()}
            disabled={
              busy !== undefined || displayName.trim().length === 0 || command.trim().length === 0
            }
          >
            <Plus size={16} /> {editingId === undefined ? "Add Agent" : "Save Agent"}
          </button>
        </aside>
      </div>
    </section>
  );
}
