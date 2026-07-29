import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentProfileId } from "@honeybee/domain";

import type {
  AgentAdapter,
  AgentDetection,
  AgentDetectionContext,
  AgentLaunchRequest,
  AgentLaunchSpec,
} from "./types.js";

export interface CustomCommandAgentDefinition {
  readonly id: AgentProfileId;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: boolean;
}

export type CommandLocator = (
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
) => Promise<string | undefined>;

export interface CustomCommandAgentAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly commandLocator?: CommandLocator;
  readonly directoryExists?: (directory: string) => Promise<boolean>;
}

export class AgentAdapterError extends Error {
  public override readonly name = "AgentAdapterError";

  public constructor(
    public readonly code: "invalid-command" | "missing-cwd",
    message: string,
  ) {
    super(message);
  }
}

const environmentValue = (
  environment: Readonly<Record<string, string>>,
  key: string,
): string | undefined => {
  const entry = Object.entries(environment).find(
    ([candidate]) => candidate.toLocaleUpperCase() === key.toLocaleUpperCase(),
  );
  return entry?.[1];
};

const mergeEnvironment = (
  platform: NodeJS.Platform,
  ...sources: readonly Readonly<Record<string, string | undefined>>[]
): Readonly<Record<string, string>> => {
  const values = new Map<string, Readonly<{ key: string; value: string }>>();

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const comparisonKey = platform === "win32" ? key.toLocaleUpperCase() : key;
      if (value === undefined) {
        values.delete(comparisonKey);
      } else {
        values.set(comparisonKey, { key, value });
      }
    }
  }

  return Object.fromEntries([...values.values()].map(({ key, value }) => [key, value]));
};

const commandCandidates = (
  command: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): readonly string[] => {
  const pathApi = platform === "win32" ? path.win32 : path;
  const pathLike = pathApi.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const baseCandidates = pathLike
    ? [pathApi.isAbsolute(command) ? command : pathApi.resolve(cwd, command)]
    : (environmentValue(environment, "PATH") ?? "")
        .split(platform === "win32" ? ";" : path.delimiter)
        .filter((entry) => entry.length > 0)
        .map((directory) => pathApi.join(directory, command));

  if (platform !== "win32" || pathApi.extname(command).length > 0) {
    return baseCandidates;
  }

  const pathExtensions = (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.length > 0);
  return baseCandidates.flatMap((candidate) => [
    candidate,
    ...pathExtensions.map((extension) => `${candidate}${extension.toLocaleLowerCase()}`),
  ]);
};

export const locateCommand: CommandLocator = async (command, cwd, environment, platform) => {
  for (const candidate of commandCandidates(command, cwd, environment, platform)) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH/PATHEXT candidate.
    }
  }
  return undefined;
};

const defaultDirectoryExists = async (directory: string): Promise<boolean> => {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
};

export class CustomCommandAgentAdapter implements AgentAdapter {
  readonly #platform: NodeJS.Platform;
  readonly #processEnv: Readonly<NodeJS.ProcessEnv>;
  readonly #commandLocator: CommandLocator;
  readonly #directoryExists: (directory: string) => Promise<boolean>;

  public constructor(
    public readonly definition: CustomCommandAgentDefinition,
    options: CustomCommandAgentAdapterOptions = {},
  ) {
    if (definition.command.trim().length === 0) {
      throw new AgentAdapterError("invalid-command", "Custom command cannot be empty.");
    }
    this.#platform = options.platform ?? process.platform;
    this.#processEnv = options.processEnv ?? process.env;
    this.#commandLocator = options.commandLocator ?? locateCommand;
    this.#directoryExists = options.directoryExists ?? defaultDirectoryExists;
  }

  public async detect(context: AgentDetectionContext = {}): Promise<AgentDetection> {
    const cwd = this.#resolveCwd(context.cwd);
    if (!(await this.#directoryExists(cwd))) {
      return { available: false, profileId: this.definition.id, reason: "cwd-not-found" };
    }

    const environment = mergeEnvironment(
      this.#platform,
      this.#processEnv,
      this.definition.env ?? {},
      context.env ?? {},
    );
    const resolvedCommand = await this.#commandLocator(
      this.definition.command,
      cwd,
      environment,
      this.#platform,
    );
    return resolvedCommand === undefined
      ? { available: false, profileId: this.definition.id, reason: "command-not-found" }
      : { available: true, profileId: this.definition.id, resolvedCommand };
  }

  public createLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    const cwd = this.#resolveCwd(request.cwd);
    const env = mergeEnvironment(
      this.#platform,
      this.#processEnv,
      this.definition.env ?? {},
      request.env ?? {},
      { HONEYBEE_SESSION_ID: request.sessionId },
    );

    return {
      command: this.definition.command,
      args: [...(this.definition.args ?? []), ...(request.additionalArgs ?? [])],
      cwd,
      env,
      shell: this.definition.shell ?? false,
    };
  }

  #resolveCwd(requestCwd: string | undefined): string {
    const cwd = requestCwd ?? this.definition.cwd;
    if (cwd === undefined || cwd.trim().length === 0) {
      throw new AgentAdapterError("missing-cwd", "A Windows working directory is required.");
    }
    return this.#platform === "win32" ? path.win32.resolve(cwd) : path.resolve(cwd);
  }
}
