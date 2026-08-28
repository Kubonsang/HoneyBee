import {
  UnityAgentConfigSchema,
  UnityBatchConfigSchema,
  UnityWorkConfigSchema,
  prepareAgentLaunch,
  type UnityAgentConfig,
  type UnityBatchConfig,
  type UnityWorkConfig,
} from "@honeybee/core";

const prepareDirectCliAgent = async (agentValue: unknown): Promise<UnityAgentConfig> => {
  const agent = UnityAgentConfigSchema.parse(agentValue);
  if (agent.trust !== undefined || agent.adapter !== "stdio-framed-v2") return agent;
  const prepared = await prepareAgentLaunch(agent.command);
  return UnityAgentConfigSchema.parse({
    ...agent,
    command: prepared.command,
    trust: prepared.trust,
  });
};

export const prepareDirectUnityWorkConfig = async <T extends UnityWorkConfig>(
  config: T,
): Promise<T> =>
  UnityWorkConfigSchema.parse({
    ...config,
    agent: await prepareDirectCliAgent(config.agent),
  }) as T;

export const prepareDirectUnityBatchConfig = async <T extends UnityBatchConfig>(
  config: T,
): Promise<T> => {
  const preparedTransactionAgent = await prepareDirectCliAgent(config.transaction.agent);
  const transactionAgent = {
    command: preparedTransactionAgent.command,
    ...(preparedTransactionAgent.trust === undefined
      ? {}
      : { trust: preparedTransactionAgent.trust }),
    harness: preparedTransactionAgent.harness,
    ...(preparedTransactionAgent.timeoutMs === undefined
      ? {}
      : { timeoutMs: preparedTransactionAgent.timeoutMs }),
    ...(preparedTransactionAgent.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: preparedTransactionAgent.maxOutputBytes }),
  };
  return UnityBatchConfigSchema.parse({
    ...config,
    transaction: {
      ...config.transaction,
      agent: transactionAgent,
    },
    ...(config.schemaVersion === 4
      ? {
          works: await Promise.all(
            config.works.map(async (work) => ({
              ...work,
              agent: await prepareDirectCliAgent(work.agent),
            })),
          ),
        }
      : {}),
  }) as T;
};
