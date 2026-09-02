import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DesktopDeveloperSettingsV1Schema,
  DesktopAgentProfileV1Schema,
  DesktopAgentUpsertRequestV1Schema,
  DesktopProjectProfileSchema,
  SetupCommandSchema,
  type DesktopAgentProfileV1,
  type AgentLaunchTrustV1,
  type DesktopAgentUpsertRequestV1,
  type DesktopProjectProfile,
  type SetupCommand,
} from "../shared/ipc.js";

const DesktopSettingsV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
    agents: z.array(DesktopAgentProfileV1Schema).max(50),
    preferredAgentIds: z.record(z.string().uuid(), z.string().uuid()),
    lastUsedAgentId: z.string().uuid().optional(),
    developer: DesktopDeveloperSettingsV1Schema,
  })
  .strict();

const DesktopSettingsV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
    agents: z.array(DesktopAgentProfileV1Schema).max(50),
    preferredAgentIds: z.record(z.string().uuid(), z.string().uuid()),
    lastUsedAgentId: z.string().uuid().optional(),
    developer: z
      .object({
        schemaVersion: z.literal(1),
        dogfoodMetricsEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict();

const DesktopSettingsV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
    agents: z.array(DesktopAgentProfileV1Schema).max(50),
    preferredAgentIds: z.record(z.string().uuid(), z.string().uuid()),
    lastUsedAgentId: z.string().uuid().optional(),
  })
  .strict();

const DesktopSettingsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
  })
  .strict();

const DesktopSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
  })
  .strict();

type DesktopSettingsV5 = z.infer<typeof DesktopSettingsV5Schema>;
export type DesktopSettingsSnapshot = Readonly<DesktopSettingsV5>;

const emptySettings = (): DesktopSettingsV5 =>
  DesktopSettingsV5Schema.parse({
    schemaVersion: 5,
    profiles: [],
    agents: [],
    preferredAgentIds: {},
    developer: {
      schemaVersion: 1,
      dogfoodMetricsEnabled: false,
      rawAgentProtocolEnabled: false,
    },
  });

const operationTails = new Map<string, Promise<void>>();

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const canonicalCommand = (command: SetupCommand): string =>
  JSON.stringify({
    command: command.command,
    args: command.args ?? [],
    cwd: command.cwd ?? null,
  });

const agentIdFor = (command: SetupCommand): string => {
  const bytes = createHash("sha256")
    .update("honeybee-desktop-agent-profile-v1\0", "utf8")
    .update(canonicalCommand(command), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const providerFor = (command: string): DesktopAgentProfileV1["provider"] => {
  const name = path.basename(command, path.extname(command)).toLowerCase();
  if (name.includes("opencode")) return "opencode";
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  return "custom";
};

const labelFor = (provider: DesktopAgentProfileV1["provider"]): string =>
  provider === "opencode"
    ? "OpenCode"
    : provider === "claude"
      ? "Claude Code"
      : provider === "codex"
        ? "Codex"
        : "Custom Agent";

const embeddedAgent = (profile: DesktopProjectProfile): SetupCommand | undefined =>
  profile.schemaVersion === 2 || profile.schemaVersion === 3
    ? SetupCommandSchema.parse(profile.environment.agent)
    : undefined;

const migrate = (profiles: readonly DesktopProjectProfile[]): DesktopSettingsV5 => {
  const now = new Date().toISOString();
  const agents = new Map<string, DesktopAgentProfileV1>();
  const preferredAgentIds: Record<string, string> = {};
  for (const profile of profiles) {
    const command = embeddedAgent(profile);
    if (command === undefined) continue;
    const key = canonicalCommand(command);
    let agent = agents.get(key);
    if (agent === undefined) {
      const provider = providerFor(command.command);
      agent = DesktopAgentProfileV1Schema.parse({
        schemaVersion: 1,
        agentId: agentIdFor(command),
        displayName: labelFor(provider),
        provider,
        command,
        adapter: "stdio-framed-v2",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      agents.set(key, agent);
    }
    preferredAgentIds[profile.profileId] = agent.agentId;
  }
  const values = [...agents.values()];
  return DesktopSettingsV5Schema.parse({
    schemaVersion: 5,
    profiles,
    agents: values,
    preferredAgentIds,
    ...(values[0] === undefined ? {} : { lastUsedAgentId: values[0].agentId }),
    developer: {
      schemaVersion: 1,
      dogfoodMetricsEnabled: false,
      rawAgentProtocolEnabled: false,
    },
  });
};

const migrateV3 = (settings: z.infer<typeof DesktopSettingsV3Schema>): DesktopSettingsV5 =>
  DesktopSettingsV5Schema.parse({
    ...settings,
    schemaVersion: 5,
    developer: {
      schemaVersion: 1,
      dogfoodMetricsEnabled: false,
      rawAgentProtocolEnabled: false,
    },
  });

const migrateV4 = (settings: z.infer<typeof DesktopSettingsV4Schema>): DesktopSettingsV5 =>
  DesktopSettingsV5Schema.parse({
    ...settings,
    schemaVersion: 5,
    developer: {
      ...settings.developer,
      rawAgentProtocolEnabled: false,
    },
  });

export class DesktopSettingsStore {
  readonly #directory: string;
  readonly #filePath: string;

  public constructor(userDataDirectory: string) {
    this.#directory = path.resolve(userDataDirectory);
    this.#filePath = path.join(this.#directory, "settings-v5.json");
  }

  public async snapshot(): Promise<DesktopSettingsSnapshot> {
    return this.#serialized(() => this.#read());
  }

  public async listProfiles(): Promise<readonly DesktopProjectProfile[]> {
    return this.#serialized(async () => {
      const settings = await this.#read();
      return [...settings.profiles].sort((left, right) =>
        right.lastOpenedAt.localeCompare(left.lastOpenedAt),
      );
    });
  }

  public async listAgents(): Promise<readonly DesktopAgentProfileV1[]> {
    return this.#serialized(async () => (await this.#read()).agents);
  }

  public async developerSettings() {
    return this.#serialized(async () => (await this.#read()).developer);
  }

  public async updateDeveloperSettings(value: unknown) {
    return this.#serialized(async () => {
      const developer = DesktopDeveloperSettingsV1Schema.parse(value);
      const settings = await this.#read();
      await this.#write({ ...settings, developer });
      return developer;
    });
  }

  public async agent(agentId: string): Promise<DesktopAgentProfileV1 | undefined> {
    return this.#serialized(async () =>
      (await this.#read()).agents.find((agent) => agent.agentId === agentId),
    );
  }

  public async upsertAgent(
    requestValue: DesktopAgentUpsertRequestV1,
    trust?: AgentLaunchTrustV1,
  ): Promise<DesktopAgentProfileV1> {
    return this.#serialized(async () => {
      const request = DesktopAgentUpsertRequestV1Schema.parse(requestValue);
      const settings = await this.#read();
      const existing =
        request.agentId === undefined
          ? undefined
          : settings.agents.find((agent) => agent.agentId === request.agentId);
      const now = new Date().toISOString();
      const profile = DesktopAgentProfileV1Schema.parse({
        schemaVersion: 1,
        agentId: request.agentId ?? randomUUID(),
        displayName: request.displayName,
        provider: request.provider,
        command: request.command,
        ...(trust === undefined ? {} : { trust }),
        adapter: request.adapter,
        enabled: request.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const agents = [
        profile,
        ...settings.agents.filter((agent) => agent.agentId !== profile.agentId),
      ];
      await this.#write({
        ...settings,
        agents,
        lastUsedAgentId: settings.lastUsedAgentId ?? profile.agentId,
      });
      return profile;
    });
  }

  public async removeAgent(agentId: string): Promise<void> {
    await this.#serialized(async () => {
      const settings = await this.#read();
      const preferredAgentIds = Object.fromEntries(
        Object.entries(settings.preferredAgentIds).filter(([, value]) => value !== agentId),
      );
      const agents = settings.agents.filter((agent) => agent.agentId !== agentId);
      await this.#write({
        ...settings,
        agents,
        preferredAgentIds,
        ...(settings.lastUsedAgentId === agentId
          ? agents[0] === undefined
            ? { lastUsedAgentId: undefined }
            : { lastUsedAgentId: agents[0].agentId }
          : {}),
      });
    });
  }

  public async setPreferredAgent(profileId: string, agentId: string): Promise<void> {
    await this.#serialized(async () => {
      const settings = await this.#read();
      if (!settings.profiles.some((profile) => profile.profileId === profileId))
        throw new Error("Project profile was not found.");
      if (!settings.agents.some((agent) => agent.agentId === agentId && agent.enabled))
        throw new Error("Agent profile was not found or is disabled.");
      await this.#write({
        ...settings,
        preferredAgentIds: { ...settings.preferredAgentIds, [profileId]: agentId },
        lastUsedAgentId: agentId,
      });
    });
  }

  public async markAgentUsed(agentId: string): Promise<void> {
    await this.#serialized(async () => {
      const settings = await this.#read();
      if (!settings.agents.some((agent) => agent.agentId === agentId)) return;
      await this.#write({ ...settings, lastUsedAgentId: agentId });
    });
  }

  public async upsertProfile(profileValue: DesktopProjectProfile): Promise<void> {
    await this.#serialized(async () => {
      const profile = DesktopProjectProfileSchema.parse(profileValue);
      const settings = await this.#read();
      const projectKey = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      const replacedIds = settings.profiles
        .filter(
          (candidate) =>
            candidate.profileId !== profile.profileId &&
            profile.schemaVersion !== 1 &&
            candidate.schemaVersion !== 1 &&
            projectKey(candidate.projectPath) === projectKey(profile.projectPath),
        )
        .map((candidate) => candidate.profileId);
      const profiles = settings.profiles.filter(
        (candidate) =>
          candidate.profileId !== profile.profileId &&
          !(
            profile.schemaVersion !== 1 &&
            candidate.schemaVersion !== 1 &&
            projectKey(candidate.projectPath) === projectKey(profile.projectPath)
          ) &&
          !(
            candidate.projectPath === profile.projectPath &&
            candidate.batchConfigPath === profile.batchConfigPath
          ),
      );
      const replacementPreference = replacedIds
        .map((id) => settings.preferredAgentIds[id])
        .find((value) => value !== undefined);
      const preferredAgentIds = {
        ...Object.fromEntries(
          Object.entries(settings.preferredAgentIds).filter(
            ([profileId]) => !replacedIds.includes(profileId),
          ),
        ),
        ...(replacementPreference === undefined
          ? {}
          : { [profile.profileId]: replacementPreference }),
      };
      await this.#write({
        ...settings,
        profiles: [profile, ...profiles].slice(0, 50),
        preferredAgentIds,
      });
    });
  }

  public async removeProfile(profileId: string): Promise<void> {
    await this.#serialized(async () => {
      const settings = await this.#read();
      const preferredAgentIds = Object.fromEntries(
        Object.entries(settings.preferredAgentIds).filter(([candidate]) => candidate !== profileId),
      );
      await this.#write({
        ...settings,
        profiles: settings.profiles.filter((profile) => profile.profileId !== profileId),
        preferredAgentIds,
      });
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? this.#filePath.toLowerCase() : this.#filePath;
    const previous = operationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    operationTails.set(key, tail);
    void tail.then(() => {
      if (operationTails.get(key) === tail) operationTails.delete(key);
    });
    return result;
  }

  async #read(): Promise<DesktopSettingsV5> {
    try {
      const entry = await lstat(this.#filePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) {
        throw new Error("invalid settings file");
      }
      return DesktopSettingsV5Schema.parse(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        throw new Error("Desktop settings are invalid or unreadable.", { cause: error });
      try {
        const legacy = DesktopSettingsV4Schema.parse(
          JSON.parse(await readFile(path.join(this.#directory, "settings-v4.json"), "utf8")),
        );
        const migrated = migrateV4(legacy);
        await this.#write(migrated);
        return migrated;
      } catch (legacyError) {
        if (errorCode(legacyError) !== "ENOENT")
          throw new Error("Desktop settings are invalid or unreadable.", { cause: legacyError });
      }
      try {
        const legacy = DesktopSettingsV3Schema.parse(
          JSON.parse(await readFile(path.join(this.#directory, "settings-v3.json"), "utf8")),
        );
        const migrated = migrateV3(legacy);
        await this.#write(migrated);
        return migrated;
      } catch (legacyError) {
        if (errorCode(legacyError) !== "ENOENT")
          throw new Error("Desktop settings are invalid or unreadable.", { cause: legacyError });
      }
      for (const [fileName, schema] of [
        ["settings-v2.json", DesktopSettingsV2Schema],
        ["settings-v1.json", DesktopSettingsV1Schema],
      ] as const) {
        try {
          const legacy = schema.parse(
            JSON.parse(await readFile(path.join(this.#directory, fileName), "utf8")),
          );
          const migrated = migrate(legacy.profiles);
          await this.#write(migrated);
          return migrated;
        } catch (legacyError) {
          if (errorCode(legacyError) !== "ENOENT")
            throw new Error("Desktop settings are invalid or unreadable.", { cause: legacyError });
        }
      }
      return emptySettings();
    }
  }

  async #write(value: unknown): Promise<void> {
    const settings = DesktopSettingsV5Schema.parse(value);
    await mkdir(this.#directory, { recursive: true });
    const directory = await lstat(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("Desktop settings directory is unsafe.");
    }
    const temporaryPath = path.join(this.#directory, `.settings-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(Buffer.from(JSON.stringify(settings), "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
