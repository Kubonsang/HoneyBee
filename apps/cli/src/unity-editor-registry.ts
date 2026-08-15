import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  EventIdSchema,
  UnityEditorObservationV1Schema,
  type UnityEditorObservationV1,
} from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError } from "@honeybee/core";

import { SystemUnityProcessControl, type UnityProcessControl } from "./process-control.js";

const execFileAsync = promisify(execFile);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export interface OsUnityEditorProcess {
  readonly pid: number;
  readonly executablePath?: string;
  readonly commandLine?: string;
}

export type DiscoverUnityEditors = () => Promise<readonly OsUnityEditorProcess[]>;

const discoverUnityEditors: DiscoverUnityEditors = async () => {
  if (process.platform === "win32") {
    const script = String.raw`$items = @(Get-CimInstance Win32_Process -Filter "Name = 'Unity.exe'" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; executablePath = $_.ExecutablePath; commandLine = $_.CommandLine } }); [Console]::Out.Write(($items | ConvertTo-Json -Compress))`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.length === 0 ? "[]" : stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): OsUnityEditorProcess[] => {
      if (typeof value !== "object" || value === null || !("pid" in value)) return [];
      const pid = value.pid;
      if (!Number.isInteger(pid) || (pid as number) <= 0) return [];
      const executablePath = "executablePath" in value ? value.executablePath : undefined;
      const commandLine = "commandLine" in value ? value.commandLine : undefined;
      return [
        {
          pid: pid as number,
          ...(typeof executablePath === "string" && executablePath.length > 0
            ? { executablePath }
            : {}),
          ...(typeof commandLine === "string" && commandLine.length > 0 ? { commandLine } : {}),
        },
      ];
    });
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return stdout.split(/\r?\n/u).flatMap((line): OsUnityEditorProcess[] => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      !/(?:^|[\\/])Unity(?:\.exe)?(?:\s|$)/iu.test(match[2])
    )
      return [];
    return [{ pid: Number(match[1]), commandLine: match[2] }];
  });
};

const deterministicEditorId = (pid: number, identity: string) => {
  const bytes = createHash("sha256")
    .update("honeybee-observed-unity-editor-v1\0", "utf8")
    .update(String(pid), "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return EventIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

const tokenizeCommandLine = (commandLine: string): readonly string[] => {
  const values: string[] = [];
  const expression = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu;
  for (const match of commandLine.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) values.push(value.replace(/\\"/gu, '"'));
  }
  return values;
};

const projectPathFrom = (commandLine?: string): string | undefined => {
  if (commandLine === undefined) return undefined;
  const args = tokenizeCommandLine(commandLine);
  const index = args.findIndex((value) => value.toLocaleLowerCase("en-US") === "-projectpath");
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || !path.isAbsolute(value)) return undefined;
  return path.resolve(value);
};

const pathKey = (value: string): string =>
  process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);

const ensureDirectory = async (root: string, components: readonly string[]): Promise<string> => {
  let directory = path.resolve(root);
  await mkdir(directory, { recursive: true });
  const rootEntry = await lstat(directory);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new HoneyBeeCoreError(
      "run.indeterminate",
      "Editor Registry root is not a real directory.",
    );
  }
  for (const component of components) {
    const entryPath = path.resolve(directory, component);
    if (path.dirname(entryPath) !== directory) {
      throw new HoneyBeeCoreError("run.indeterminate", "Editor Registry path escaped its root.");
    }
    try {
      await mkdir(entryPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const entry = await lstat(entryPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new HoneyBeeCoreError("run.indeterminate", "Editor Registry path contains a link.");
    }
    directory = entryPath;
  }
  return directory;
};

const publishImmutable = async (directory: string, name: string, value: unknown): Promise<void> => {
  const finalPath = path.join(directory, name);
  const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await readFile(finalPath);
    if (!existing.equals(bytes)) {
      throw new HoneyBeeCoreError("run.indeterminate", "Editor Registry identity was overwritten.");
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

export interface UnityEditorRegistry {
  recordOwned(observation: UnityEditorObservationV1): Promise<void>;
  recordExited(editorId: UnityEditorObservationV1["editorId"]): Promise<void>;
  list(): Promise<readonly UnityEditorObservationV1[]>;
}

export class FileOsUnityEditorRegistry implements UnityEditorRegistry {
  readonly #root: string;

  public constructor(
    rootDirectory: string,
    private readonly discover: DiscoverUnityEditors = discoverUnityEditors,
    private readonly processes: UnityProcessControl = new SystemUnityProcessControl(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#root = path.resolve(rootDirectory);
  }

  public async recordOwned(observationValue: UnityEditorObservationV1): Promise<void> {
    const observation = UnityEditorObservationV1Schema.parse(observationValue);
    if (observation.ownership !== "honeybee" || observation.state !== "alive") {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Only live owned Editors can be registered.",
      );
    }
    const actualIdentity = await this.processes.captureIdentity(observation.pid);
    if (actualIdentity !== observation.processIdentity) {
      throw new HoneyBeeCoreError(
        "process.identity-failed",
        "Editor ownership PID incarnation changed.",
      );
    }
    const directory = await ensureDirectory(this.#root, [".unity-editors", "v1", "owned"]);
    await publishImmutable(directory, `${observation.editorId}.json`, observation);
  }

  public async recordExited(editorIdValue: UnityEditorObservationV1["editorId"]): Promise<void> {
    const editorId = EventIdSchema.parse(editorIdValue);
    const directory = await ensureDirectory(this.#root, [".unity-editors", "v1", "exited"]);
    await publishImmutable(directory, `${editorId}.json`, {
      schemaVersion: 1,
      editorId,
      exitedAt: this.now().toISOString(),
    });
  }

  public async list(): Promise<readonly UnityEditorObservationV1[]> {
    const [owned, exited, discovered] = await Promise.all([
      this.#readOwned(),
      this.#readExited(),
      this.discover().catch(() => []),
    ]);
    const observations: UnityEditorObservationV1[] = [];
    const seen = new Set<string>();
    for (const processValue of discovered) {
      const identity = await this.processes
        .captureIdentity(processValue.pid)
        .catch(() => undefined);
      if (identity === undefined) continue;
      const key = `${processValue.pid}\0${identity}`;
      seen.add(key);
      const durable = owned.find(
        (candidate) => candidate.pid === processValue.pid && candidate.processIdentity === identity,
      );
      if (durable !== undefined && !exited.has(durable.editorId)) {
        observations.push(
          UnityEditorObservationV1Schema.parse({
            ...durable,
            state: "alive",
            observedAt: this.now().toISOString(),
          }),
        );
        continue;
      }
      const projectPath = projectPathFrom(processValue.commandLine);
      observations.push(
        UnityEditorObservationV1Schema.parse({
          schemaVersion: 1,
          editorId: deterministicEditorId(processValue.pid, identity),
          pid: processValue.pid,
          processIdentity: identity,
          ...(processValue.executablePath === undefined
            ? {}
            : { executablePath: path.resolve(processValue.executablePath) }),
          ...(projectPath === undefined ? {} : { projectPath }),
          ownership: projectPath === undefined ? "unknown" : "user",
          state: "alive",
          pathObservation: projectPath === undefined ? "unavailable" : "confirmed",
          observedAt: this.now().toISOString(),
        }),
      );
    }
    for (const durable of owned) {
      const key = `${durable.pid}\0${durable.processIdentity}`;
      if (seen.has(key)) continue;
      observations.push(
        UnityEditorObservationV1Schema.parse({
          ...durable,
          state: exited.has(durable.editorId) ? "exited" : "stale",
          observedAt: this.now().toISOString(),
        }),
      );
    }
    return observations.sort((left, right) => left.pid - right.pid);
  }

  async #readOwned(): Promise<readonly UnityEditorObservationV1[]> {
    const directory = await ensureDirectory(this.#root, [".unity-editors", "v1", "owned"]);
    const values: UnityEditorObservationV1[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/u.test(entry.name)) {
        if (/^\..+\.tmp$/u.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) continue;
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor Registry owned directory is corrupt.",
        );
      }
      const filePath = path.join(directory, entry.name);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new HoneyBeeCoreError("run.indeterminate", "Editor Registry record is not private.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch {
        throw new HoneyBeeCoreError("run.indeterminate", "Editor Registry record is malformed.");
      }
      const observation = UnityEditorObservationV1Schema.safeParse(parsed);
      if (!observation.success || observation.data.ownership !== "honeybee") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor Registry ownership record is invalid.",
        );
      }
      values.push(observation.data);
    }
    return values;
  }

  async #readExited(): Promise<ReadonlySet<string>> {
    const directory = await ensureDirectory(this.#root, [".unity-editors", "v1", "exited"]);
    const values = new Set<string>();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (/^\..+\.tmp$/u.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) continue;
      const match = /^([0-9a-f-]{36})\.json$/u.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match?.[1] === undefined) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor Registry exit directory is corrupt.",
        );
      }
      const filePath = path.join(directory, entry.name);
      const metadata = await lstat(filePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor Registry exit record is malformed.",
        );
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        typeof parsed !== "object" ||
        parsed === null ||
        !("editorId" in parsed) ||
        parsed.editorId !== match[1]
      )
        throw new HoneyBeeCoreError("run.indeterminate", "Editor Registry exit record is invalid.");
      values.add(EventIdSchema.parse(match[1]));
    }
    return values;
  }
}

export const sameEditorProjectPath = (left: string, right: string): boolean =>
  pathKey(left) === pathKey(right);
