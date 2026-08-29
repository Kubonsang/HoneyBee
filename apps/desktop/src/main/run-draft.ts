import {
  UnityBatchConfigV4Schema,
  UnityWorkConfigV2Schema,
  type UnityAgentConfig,
  type UnityCapability,
} from "@honeybee/orchestration-contracts";

import {
  DesktopClonedRunDraftV1Schema,
  type DesktopAgentProfileV1,
  type DesktopClonedRunDraftV1,
} from "../shared/ipc.js";

interface CloneRunDraftInput {
  readonly sourceRunId: string;
  readonly profileId: string;
  readonly preferredAgentId?: string | undefined;
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly config: unknown;
  readonly task?: string | undefined;
  readonly workId?: string | undefined;
}

const commandIdentity = (command: UnityAgentConfig["command"]): string =>
  JSON.stringify({
    command: command.command,
    args: command.args ?? [],
    cwd: command.cwd ?? null,
  });

const agentIdentity = (agent: UnityAgentConfig): string =>
  JSON.stringify({
    command: commandIdentity(agent.command),
    trust: agent.trust ?? null,
    adapter: agent.adapter,
  });

const profileIdentity = (agent: DesktopAgentProfileV1): string =>
  JSON.stringify({
    command: commandIdentity(agent.command),
    trust: agent.trust ?? null,
    adapter: agent.adapter,
  });

const matchAgent = (
  snapshot: UnityAgentConfig,
  agents: readonly DesktopAgentProfileV1[],
): DesktopAgentProfileV1 | undefined => {
  const identity = agentIdentity(snapshot);
  return agents.find((agent) => agent.enabled && profileIdentity(agent) === identity);
};

const capabilityDraft = (
  capabilities: readonly UnityCapability[],
): Readonly<{ compile: boolean; warmTest: boolean; filter: string }> => {
  const warmTest = capabilities.find((capability) => capability.kind === "warm-test");
  return {
    compile: capabilities.some((capability) => capability.kind === "compile"),
    warmTest: warmTest !== undefined,
    filter: warmTest?.kind === "warm-test" ? (warmTest.filter ?? warmTest.category ?? "") : "",
  };
};

export const cloneRunDraftFromConfig = (input: CloneRunDraftInput): DesktopClonedRunDraftV1 => {
  const batch = UnityBatchConfigV4Schema.safeParse(input.config);
  const single = UnityWorkConfigV2Schema.safeParse(input.config);
  if (!batch.success && !single.success) {
    throw Object.assign(new Error("This Run does not contain a supported v0.6 Work config."), {
      code: "desktop.clone-unavailable",
    });
  }

  const sourceWorks = batch.success
    ? batch.data.works.map((work) => ({
        id: work.id,
        task: work.task,
        priority: work.priority,
        capabilities: work.capabilities,
        agent: work.agent,
      }))
    : (() => {
        const config = UnityWorkConfigV2Schema.parse(input.config);
        return [
          {
            id: input.workId ?? "work-1",
            task: input.task?.trim() ?? "",
            priority: config.priority,
            capabilities: config.capabilities,
            agent: config.agent,
          },
        ];
      })();

  if (sourceWorks.some((work) => work.task.length === 0)) {
    throw Object.assign(new Error("The original Work task Artifact is unavailable."), {
      code: "desktop.clone-unavailable",
    });
  }

  const works = sourceWorks.map((work) => {
    const matched = matchAgent(work.agent, input.agents);
    return {
      id: work.id,
      task: work.task,
      priority: work.priority,
      ...capabilityDraft(work.capabilities),
      agentId: matched?.agentId ?? null,
      agentLabel: matched?.displayName ?? work.agent.command.command,
    };
  });
  const matchedAgentIds = new Set(
    works.flatMap((work) => (work.agentId === null ? [] : [work.agentId])),
  );
  const defaultAgentId =
    input.preferredAgentId !== undefined && matchedAgentIds.has(input.preferredAgentId)
      ? input.preferredAgentId
      : (works.find((work) => work.agentId !== null)?.agentId ?? null);

  return DesktopClonedRunDraftV1Schema.parse({
    schemaVersion: 1,
    sourceRunId: input.sourceRunId,
    profileId: input.profileId,
    defaultAgentId,
    maxParallelWorks: batch.success ? batch.data.maxParallelWorks : 1,
    works,
  });
};
