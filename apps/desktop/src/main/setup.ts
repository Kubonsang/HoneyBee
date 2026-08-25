import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { UnityBatchConfigV3Schema } from "@honeybee/orchestration-contracts";
import { RuntimeProcessContainment } from "honeybee-cli/runtime";

import {
  DesktopProjectProfileV2Schema,
  DesktopSetupDiscoveryV1Schema,
  DesktopSetupDraftV1Schema,
  DesktopSetupStatusV1Schema,
  ManagedUnityEnvironmentV1Schema,
  type DesktopProjectProfileV2,
  type DesktopSetupDiscoveryV1,
  type DesktopSetupDraftV1,
  type DesktopSetupStatusV1,
  type ManagedUnityEnvironmentV1,
} from "../shared/ipc.js";

const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const PROJECT_DIRECTORIES = ["Assets", "Packages", "ProjectSettings"] as const;
const COMPATIBLE_PROJECT_SETTINGS = [
  "AudioManager.asset",
  "DynamicsManager.asset",
  "EditorBuildSettings.asset",
  "EditorSettings.asset",
  "GraphicsSettings.asset",
  "MemorySettings.asset",
  "NavMeshAreas.asset",
  "PackageManagerSettings.asset",
  "Physics2DSettings.asset",
  "ProjectSettings.asset",
  "ProjectVersion.txt",
  "QualitySettings.asset",
  "TagManager.asset",
  "TimeManager.asset",
  "VFXManager.asset",
  "XRSettings.asset",
] as const;

type SetupEventType =
  | "setup.started"
  | "setup.validated"
  | "parent.begin-started"
  | "parent.begun"
  | "parent.shell-prepared"
  | "unity.started"
  | "unity.containment-registered"
  | "unity.exited"
  | "unity.containment-drained"
  | "parent.validated"
  | "parent.commit-started"
  | "parent.committed"
  | "parent.shell-cleaned"
  | "parent.abort-started"
  | "parent.aborted"
  | "profile.stored"
  | "setup.completed"
  | "setup.failed"
  | "setup.cancelled"
  | "setup.recovery-required";

interface SetupEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: SetupEventType;
  readonly payload: Record<string, unknown>;
}

interface StorageResponse {
  readonly schemaVersion: 2;
  readonly requestId: string;
  readonly ok: boolean;
  readonly provider?: string;
  readonly transactionId?: string;
  readonly stagingPath?: string;
  readonly parent?: Readonly<{
    parentId?: string;
    compatibilityKey?: string;
    provider?: string;
    immutable?: boolean;
  }>;
  readonly error?: Readonly<{ code?: string }>;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly pid?: number;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const setupError = (code: string, message: string): Error & { readonly code: string } =>
  Object.assign(new Error(message), { code });

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const hashFile = async (filePath: string): Promise<string> => {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a real file: ${filePath}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

const publishExclusiveFile = async (target: string, content: string): Promise<void> => {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const publishIdempotentFile = async (target: string, content: string): Promise<void> => {
  try {
    await publishExclusiveFile(target, content);
  } catch (error) {
    if (errorCode(error) !== "EEXIST" || (await readFile(target, "utf8")) !== content) {
      throw error;
    }
  }
};

const assertPinnedNativeExecutable = (filePathValue: string, label: string): void => {
  if (process.platform === "win32" && path.extname(filePathValue).toLowerCase() !== ".exe") {
    throw new Error(`${label} must be a directly pinned .exe, not a command wrapper.`);
  }
};

const assertPhysicalRootsDisjoint = async (
  leftValue: string,
  rightValue: string,
): Promise<void> => {
  const [left, right] = await Promise.all([
    realpath(path.resolve(leftValue)),
    realpath(path.resolve(rightValue)),
  ]);
  const contains = (root: string, candidatePath: string): boolean => {
    const relative = path.relative(root, candidatePath);
    return (
      relative.length === 0 ||
      (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
    );
  };
  if (contains(left, right) || contains(right, left)) {
    throw new Error("Unity source and workspace storage roots must be physically disjoint.");
  }
};

const filesUnder = async (root: string): Promise<readonly string[]> => {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${root}`);
  }
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error(`Reparse entries are not allowed: ${target}`);
      if (metadata.isDirectory()) await visit(target);
      else if (metadata.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
      else throw new Error(`Unsupported filesystem entry: ${target}`);
    }
  };
  await visit(root);
  return files;
};

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  hash.update("honeybee-setup-tree-v1\0", "utf8");
  for (const relative of await filesUnder(root)) {
    const filePath = path.join(root, ...relative.split("/"));
    const content = await lstat(filePath);
    if (!content.isFile() || content.isSymbolicLink()) {
      throw new Error(`Tree entry changed while hashing: ${filePath}`);
    }
    const relativeBytes = Buffer.from(relative, "utf8");
    const relativeLength = Buffer.allocUnsafe(8);
    const contentLength = Buffer.allocUnsafe(8);
    relativeLength.writeBigUInt64BE(BigInt(relativeBytes.byteLength));
    contentLength.writeBigUInt64BE(BigInt(content.size));
    hash.update(relativeLength);
    hash.update(relativeBytes);
    hash.update(contentLength);
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
    const after = await lstat(filePath);
    if (
      after.dev !== content.dev ||
      after.ino !== content.ino ||
      after.size !== content.size ||
      after.mtimeMs !== content.mtimeMs
    ) {
      throw new Error(`Tree entry changed while hashing: ${filePath}`);
    }
  }
  return hash.digest("hex");
};

const canonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== "object" || input === null) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
};

const readUnityVersion = async (projectPath: string): Promise<string> => {
  const content = await readFile(
    path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
    "utf8",
  );
  const version = /^m_EditorVersion:\s*(\S+)/mu.exec(content)?.[1];
  if (version === undefined) throw new Error("ProjectVersion.txt has no Unity version.");
  return version;
};

const projectSettingsManifest = async (projectPath: string): Promise<string> => {
  const hash = createHash("sha256");
  hash.update("honeybee-project-settings-compatibility-v1\0", "utf8");
  for (const name of [...COMPATIBLE_PROJECT_SETTINGS].sort()) {
    const target = path.join(projectPath, "ProjectSettings", name);
    try {
      const content = await readFile(target);
      hash.update(Buffer.from(name.length.toString().padStart(8, "0") + name, "utf8"));
      hash.update(Buffer.from(content.byteLength.toString().padStart(16, "0"), "utf8"));
      hash.update(content);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return hash.digest("hex");
};

const scriptingBackend = async (projectPath: string): Promise<string> => {
  const content = await readFile(
    path.join(projectPath, "ProjectSettings", "ProjectSettings.asset"),
    "utf8",
  );
  return (
    content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith("scriptingBackend:")) ?? "covered-by-settings-manifest"
  );
};

export const computeUnityCompatibility = async (
  projectPathValue: string,
  unityPathValue: string,
  bridgeOverlayPathValue?: string,
) => {
  const projectPath = path.resolve(projectPathValue);
  const lockPath = path.join(projectPath, "Packages", "packages-lock.json");
  const inputs = ManagedUnityEnvironmentV1Schema.shape.compatibilityInputs.parse({
    schemaVersion: 1,
    unityVersion: await readUnityVersion(projectPath),
    unityExecutableSha256: await hashFile(path.resolve(unityPathValue)),
    packagesManifestSha256: await hashFile(path.join(projectPath, "Packages", "manifest.json")),
    packagesLockSha256: await hashFile(lockPath).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return "missing" as const;
      throw error;
    }),
    projectSettingsManifestSha256: await projectSettingsManifest(projectPath),
    buildTarget: "StandaloneWindows64",
    scriptingBackend: await scriptingBackend(projectPath),
    ...(bridgeOverlayPathValue === undefined
      ? {}
      : {
          bridgeOverlayDigest: await hashTree(path.resolve(bridgeOverlayPathValue)),
          bridgeProtocolVersion: 3 as const,
        }),
  });
  return {
    compatibilityKey: sha256(
      Buffer.concat([
        Buffer.from("honeybee-library-compatibility-v1\0", "utf8"),
        Buffer.from(canonicalJson(inputs), "utf8"),
      ]),
    ),
    inputs,
    ...(inputs.bridgeOverlayDigest === undefined
      ? {}
      : { bridgeOverlayDigest: inputs.bridgeOverlayDigest }),
  } as const;
};

const managedRuntimeConfig = (environment: ManagedUnityEnvironmentV1) => {
  const baseWork = (id: string) => ({
    id,
    task: "Desktop runtime placeholder; replaced before execution.",
    priority: "validation" as const,
    capabilities: [],
  });
  return UnityBatchConfigV3Schema.parse({
    schemaVersion: 3,
    mode: "unity-batch",
    resourceScope: "global-editor-pool-v2",
    maxParallelWorks: 1,
    transaction: {
      schemaVersion: 1,
      sourceProjectPath: environment.projectPath,
      workspaceStorage: {
        schemaVersion: 2,
        command: { command: environment.workspaceStorage.path },
        binarySha256: environment.workspaceStorage.sha256,
        workspaceRoot: environment.workspaceStorage.workspaceRoot,
        compatibilityKey: environment.workspaceStorage.compatibilityKey,
        parentId: environment.workspaceStorage.parentId,
        provider: environment.workspaceStorage.provider,
      },
      agent: {
        command: environment.agent,
        harness: "stdio-framed-v2",
        timeoutMs: 900_000,
        maxOutputBytes: 16 * 1024 * 1024,
      },
      ...(environment.testplay === undefined
        ? {}
        : {
            testplay: {
              command: { command: environment.testplay.path },
              unityPath: environment.unity.path,
              platform: "edit_mode" as const,
              timeoutMs: 900_000,
            },
          }),
      ...(environment.bridgeOverlay === undefined
        ? {}
        : { bridgeOverlay: environment.bridgeOverlay }),
    },
    editorPool: {
      id: "unity-editor",
      capacity: environment.editorPool.capacity,
      registrationTimeoutMs: 30_000,
      activationTimeoutMs: 120_000,
      bridgeReadyTimeoutMs: 180_000,
      capabilityTimeoutMs: 900_000,
      shutdownTimeoutMs: 60_000,
    },
    ...(environment.testplay === undefined ? {} : { bridgeProtocolVersion: 3 as const }),
    works: [baseWork("managed-work-a"), baseWork("managed-work-b")],
  });
};

const executableNames = (name: string, allowWrappers: boolean): readonly string[] =>
  process.platform === "win32"
    ? [`${name}.exe`, ...(allowWrappers ? [`${name}.cmd`, `${name}.bat`] : [])]
    : [name];

const pathCandidates = async (name: string, allowWrappers = false): Promise<string[]> => {
  const found: string[] = [];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const executable of executableNames(name, allowWrappers)) {
      const target = path.resolve(directory, executable);
      try {
        const entry = await lstat(target);
        if (entry.isFile() && !entry.isSymbolicLink()) found.push(target);
      } catch {
        // PATH entries are discovery hints, not trusted configuration.
      }
    }
  }
  return [...new Set(found.map((value) => path.normalize(value)))];
};

const candidate = (
  candidatePath: string,
  source: "environment" | "path" | "unity-hub" | "project" | "manual",
  version?: string,
) => ({
  path: candidatePath,
  label: path.basename(candidatePath),
  ...(version === undefined ? {} : { version }),
  source,
});

const unityCandidates = async (
  projectVersion: string,
): Promise<DesktopSetupDiscoveryV1["unity"]> => {
  const candidates: DesktopSetupDiscoveryV1["unity"][number][] = [];
  if (process.env.UNITY_PATH !== undefined) {
    candidates.push(candidate(path.resolve(process.env.UNITY_PATH), "environment"));
  }
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (base === undefined) continue;
      const editorRoot = path.join(base, "Unity", "Hub", "Editor");
      try {
        const versions = await readdir(editorRoot, { withFileTypes: true });
        for (const version of versions
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((left, right) => {
            if (left === projectVersion) return -1;
            if (right === projectVersion) return 1;
            return right.localeCompare(left);
          })) {
          const target = path.join(editorRoot, version, "Editor", "Unity.exe");
          if ((await lstat(target)).isFile()) {
            candidates.push(candidate(target, "unity-hub", version));
          }
        }
      } catch {
        // Unity Hub is optional.
      }
    }
  }
  return [...new Map(candidates.map((item) => [item.path.toLowerCase(), item])).values()];
};

export const discoverDesktopSetup = async (
  projectPathValue: string,
  bundledWorkspaceStoragePath?: string,
): Promise<DesktopSetupDiscoveryV1> => {
  const projectPath = path.resolve(projectPathValue);
  for (const directory of PROJECT_DIRECTORIES) {
    const entry = await lstat(path.join(projectPath, directory));
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`${directory} is not a safe Unity project directory.`);
    }
  }
  const projectVersion = await readUnityVersion(projectPath);
  const [unity, testplayPaths, agentPaths] = await Promise.all([
    unityCandidates(projectVersion),
    pathCandidates("testplay"),
    pathCandidates("opencode", true),
  ]);
  const storagePaths =
    bundledWorkspaceStoragePath === undefined ? [] : [path.resolve(bundledWorkspaceStoragePath)];
  const overlayPaths = [process.env.TESTPLAY_BRIDGE_PACKAGE]
    .filter((value): value is string => value !== undefined)
    .map((value) => path.resolve(value));
  for (const testplayPath of testplayPaths) {
    overlayPaths.push(
      path.resolve(path.dirname(testplayPath), "..", "unity", "com.testplay.bridge"),
    );
  }
  const bridges: DesktopSetupDiscoveryV1["bridgeOverlays"][number][] = [];
  for (const overlayPath of [...new Set(overlayPaths)]) {
    try {
      if ((await lstat(path.join(overlayPath, "package.json"))).isFile()) {
        bridges.push(candidate(overlayPath, "environment"));
      }
    } catch {
      // Manual selection remains available.
    }
  }
  return DesktopSetupDiscoveryV1Schema.parse({
    schemaVersion: 1,
    projectPath,
    projectVersion,
    unity,
    testplay: testplayPaths.map((value) => candidate(value, "path")),
    workspaceStorage: storagePaths.map((value) => candidate(value, "path")),
    agents: agentPaths.map((value) => candidate(value, "path")),
    bridgeOverlays: bridges,
    suggestedWorkspaceRoot: path.join(
      process.env.LOCALAPPDATA ?? path.dirname(projectPath),
      "TestPlay",
      "Workspaces",
    ),
  });
};

const runCommand = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    input?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onStarted?: (pid: number) => Promise<void>;
  }>,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const terminate = (): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.unref();
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(terminate, options.timeoutMs);
    const onAbort = (): void => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_COMMAND_BYTES) terminate();
      else target.push(value);
    };
    child.stdout.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) return;
      void (options.onStarted?.(pid) ?? Promise.resolve())
        .then(() => child.stdin.end(options.input, "utf8"))
        .catch((error: unknown) => {
          terminate();
          reject(error);
        });
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(child.pid === undefined ? {} : { pid: child.pid }),
      });
    });
  });

const copyTree = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination);
  for (const relative of await filesUnder(source)) {
    const target = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, ...relative.split("/")), target);
  }
};

const fullSourceDigest = async (projectPath: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const directory of PROJECT_DIRECTORIES) {
    hash.update(directory + "\0", "utf8");
    hash.update(await hashTree(path.join(projectPath, directory)), "utf8");
  }
  return hash.digest("hex");
};

const validateStagingProjectRoot = async (
  projectRootValue: string,
  workspaceRootValue: string,
): Promise<void> => {
  const projectRoot = path.resolve(projectRootValue);
  const workspaceRoot = path.resolve(workspaceRootValue);
  const lexicalRelative = path.relative(workspaceRoot, projectRoot);
  if (
    lexicalRelative.length === 0 ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  ) {
    throw new Error("Parent staging project is not a child of the workspace root.");
  }
  const [physicalProject, physicalWorkspace] = await Promise.all([
    realpath(projectRoot),
    realpath(workspaceRoot),
  ]);
  const physicalRelative = path.relative(physicalWorkspace, physicalProject);
  if (
    physicalRelative.length === 0 ||
    physicalRelative === ".." ||
    physicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(physicalRelative)
  ) {
    throw new Error("Parent staging project escaped the physical workspace root.");
  }
};

class SetupJournal {
  public constructor(public readonly filePath: string) {}

  public async events(): Promise<readonly SetupEvent[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return content
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line, index) => {
          const value = JSON.parse(line) as SetupEvent;
          if (value.schemaVersion !== 1 || value.sequence !== index + 1) {
            throw new Error("Setup Journal sequence is invalid.");
          }
          return value;
        });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  public async append(type: SetupEventType, payload: Record<string, unknown>): Promise<SetupEvent> {
    const events = await this.events();
    if (
      ["setup.completed", "setup.failed", "setup.cancelled"].includes(events.at(-1)?.type ?? "")
    ) {
      throw new Error("Setup Journal is already terminal.");
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const event: SetupEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    const handle = await open(this.filePath, "a");
    try {
      await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }
}

const storageResponse = (serialized: string, requestId: string): StorageResponse => {
  const value = JSON.parse(serialized) as StorageResponse;
  if (value.schemaVersion !== 2 || value.requestId !== requestId || value.ok !== true) {
    throw new Error(
      `workspace-storage rejected ${requestId}: ${value.error?.code ?? "invalid-response"}`,
    );
  }
  return value;
};

export class DesktopSetupCoordinator {
  readonly #active = new Map<string, Readonly<{ aborter: AbortController; task: Promise<void> }>>();

  public constructor(
    private readonly root: string,
    private readonly onProfile: (profile: DesktopProjectProfileV2) => Promise<void>,
    private readonly processContainment: Pick<
      RuntimeProcessContainment,
      "captureIdentity" | "drain" | "run"
    > = new RuntimeProcessContainment(),
    private readonly executeCommand: typeof runCommand = runCommand,
  ) {}

  public async start(draftValue: DesktopSetupDraftV1): Promise<DesktopSetupStatusV1> {
    const draft = DesktopSetupDraftV1Schema.parse(draftValue);
    const setupId = randomUUID();
    const directory = this.#directory(setupId);
    await mkdir(this.root, { recursive: true });
    await mkdir(directory, { recursive: false });
    await publishExclusiveFile(path.join(directory, "request.json"), JSON.stringify(draft));
    const journal = new SetupJournal(path.join(directory, "events.jsonl"));
    await journal.append("setup.started", { setupId });
    this.#launch(setupId, draft, journal);
    return this.status(setupId);
  }

  public async status(setupId: string): Promise<DesktopSetupStatusV1> {
    const directory = this.#directory(setupId);
    const events = await new SetupJournal(path.join(directory, "events.jsonl")).events();
    const latest = events.at(-1);
    if (latest === undefined) throw new Error("Setup was not found.");
    let state: DesktopSetupStatusV1["state"] = "running";
    if (latest.type === "setup.completed") state = "completed";
    else if (latest.type === "setup.failed") state = "failed";
    else if (latest.type === "setup.cancelled") state = "cancelled";
    else if (latest.type === "setup.recovery-required") state = "recovery-required";
    let profile: DesktopProjectProfileV2 | undefined;
    try {
      profile = DesktopProjectProfileV2Schema.parse(
        JSON.parse(await readFile(path.join(directory, "profile.json"), "utf8")),
      );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return DesktopSetupStatusV1Schema.parse({
      schemaVersion: 1,
      setupId,
      state,
      phase: latest.type,
      message: this.#message(latest.type),
      ...(profile === undefined ? {} : { profile }),
    });
  }

  public async resume(setupId: string): Promise<DesktopSetupStatusV1> {
    if (this.#active.has(setupId)) return this.status(setupId);
    const directory = this.#directory(setupId);
    const draft = DesktopSetupDraftV1Schema.parse(
      JSON.parse(await readFile(path.join(directory, "request.json"), "utf8")),
    );
    const journal = new SetupJournal(path.join(directory, "events.jsonl"));
    const terminal = (await journal.events()).at(-1)?.type;
    if (["setup.completed", "setup.failed", "setup.cancelled"].includes(terminal ?? "")) {
      return this.status(setupId);
    }
    this.#launch(setupId, draft, journal);
    return this.status(setupId);
  }

  public async cancel(setupId: string): Promise<DesktopSetupStatusV1> {
    const handle = await open(path.join(this.#directory(setupId), "cancel.requested"), "a");
    try {
      await handle.writeFile("1\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#active.get(setupId)?.aborter.abort();
    return this.status(setupId);
  }

  #launch(setupId: string, draft: DesktopSetupDraftV1, journal: SetupJournal): void {
    const aborter = new AbortController();
    const task = this.#run(setupId, draft, journal, aborter.signal).finally(() => {
      this.#active.delete(setupId);
    });
    this.#active.set(setupId, { aborter, task });
    void task.catch(() => undefined);
  }

  async #run(
    setupId: string,
    draft: DesktopSetupDraftV1,
    journal: SetupJournal,
    signal: AbortSignal,
  ): Promise<void> {
    const directory = this.#directory(setupId);
    let transactionId: string | undefined;
    let projectRoot: string | undefined;
    let pinnedStorageSha256: string | undefined;
    let compatibilityKey: string | undefined;
    let ambiguousBeginRequestId: string | undefined;
    let beginInvocationStarted = false;
    let committedParentExists = false;
    try {
      const existing = await journal.events();
      assertPinnedNativeExecutable(draft.workspaceStoragePath, "workspace-storage");
      const workspaceStorageSha256 = await hashFile(draft.workspaceStoragePath);
      pinnedStorageSha256 = workspaceStorageSha256;
      const durableValidation = [...existing]
        .reverse()
        .find((event) => event.type === "setup.validated");
      if (
        durableValidation !== undefined &&
        durableValidation.payload.workspaceStorageSha256 !== workspaceStorageSha256
      ) {
        await journal.append("setup.recovery-required", {
          errorCode: "setup.pinned-input-changed",
        });
        return;
      }
      const begun = [...existing].reverse().find((event) => event.type === "parent.begun");
      const validated = existing.some(
        (event) =>
          event.type === "parent.validated" &&
          begun !== undefined &&
          event.sequence > begun.sequence &&
          event.payload.transactionId === begun.payload.transactionId,
      );
      const committed = [...existing].reverse().find((event) => event.type === "parent.committed");
      committedParentExists = committed !== undefined;
      try {
        await this.#drainInterruptedUnity(existing, journal);
      } catch {
        await journal.append("setup.recovery-required", {
          errorCode: "setup.unity-drain-uncertain",
        });
        return;
      }
      const cancelRequested = signal.aborted || (await this.#cancelRequested(directory));
      if (committed !== undefined) {
        if (
          begun !== undefined &&
          !existing.some(
            (event) =>
              event.type === "parent.shell-cleaned" &&
              event.payload.projectRoot === begun.payload.projectRoot,
          )
        ) {
          await this.#cleanupOwnedShell(
            String(begun.payload.projectRoot),
            path.resolve(draft.workspaceRoot),
            setupId,
          );
          await journal.append("parent.shell-cleaned", {
            projectRoot: String(begun.payload.projectRoot),
          });
        }
        if (cancelRequested) {
          await journal.append("setup.cancelled", { errorCode: "setup.cancelled" });
          return;
        }
      }
      if (begun !== undefined && committed === undefined) {
        transactionId = String(begun.payload.transactionId);
        projectRoot = String(begun.payload.projectRoot);
        await validateStagingProjectRoot(projectRoot, draft.workspaceRoot);
        await this.#claimShell(projectRoot, setupId);
        if (cancelRequested || !validated) {
          await this.#abortParent(
            setupId,
            draft,
            journal,
            transactionId,
            projectRoot,
            workspaceStorageSha256,
          );
          transactionId = undefined;
          projectRoot = undefined;
        }
      }
      if (cancelRequested) {
        if (begun === undefined && committed === undefined) {
          const pendingBegin = [...existing]
            .reverse()
            .find((event) => event.type === "parent.begin-started");
          const durableKey = durableValidation?.payload.compatibilityKey;
          if (pendingBegin !== undefined && typeof durableKey === "string") {
            const requestId = String(pendingBegin.payload.requestId);
            try {
              const recovered = await this.#storage(
                draft,
                ["parent", "begin", "--compatibility-key", durableKey, "--request-id", requestId],
                requestId,
                new AbortController().signal,
                workspaceStorageSha256,
              );
              if (recovered.parent === undefined) {
                const begunState = await this.#recordBegunResponse(
                  setupId,
                  draft,
                  journal,
                  recovered,
                );
                await this.#abortParent(
                  setupId,
                  draft,
                  journal,
                  begunState.transactionId,
                  begunState.projectRoot,
                  workspaceStorageSha256,
                );
              }
            } catch {
              await journal.append("setup.recovery-required", {
                errorCode: "setup.parent-begin-uncertain",
              });
              return;
            }
          }
        }
        await journal.append("setup.cancelled", { errorCode: "setup.cancelled" });
        return;
      }

      assertPinnedNativeExecutable(draft.unityPath, "Unity");
      if (draft.testplayPath !== undefined) {
        assertPinnedNativeExecutable(draft.testplayPath, "TestPlay");
      }
      await assertPhysicalRootsDisjoint(draft.projectPath, draft.workspaceRoot);
      const compatibility = await computeUnityCompatibility(
        draft.projectPath,
        draft.unityPath,
        draft.bridgeOverlayPath,
      );
      compatibilityKey = compatibility.compatibilityKey;
      const testplaySha256 =
        draft.testplayPath === undefined ? undefined : await hashFile(draft.testplayPath);
      if (
        durableValidation !== undefined &&
        (durableValidation.payload.compatibilityKey !== compatibility.compatibilityKey ||
          durableValidation.payload.testplaySha256 !== testplaySha256)
      ) {
        await journal.append("setup.recovery-required", {
          errorCode: "setup.pinned-input-changed",
        });
        return;
      }
      if (committed !== undefined) {
        await this.#finishProfile(setupId, draft, journal, committed.payload);
        return;
      }

      if (durableValidation === undefined) {
        await journal.append("setup.validated", {
          compatibilityKey: compatibility.compatibilityKey,
          unityVersion: compatibility.inputs.unityVersion,
          ...(testplaySha256 === undefined ? {} : { testplaySha256 }),
          workspaceStorageSha256,
        });
      }
      const sourceBefore = await fullSourceDigest(draft.projectPath);

      let parent: StorageResponse["parent"] | undefined;
      if (transactionId === undefined) {
        const attempt = existing.filter((event) => event.type === "parent.begun").length + 1;
        const requestId = `setup-${setupId}-parent-begin-${attempt}`;
        ambiguousBeginRequestId = requestId;
        await journal.append("parent.begin-started", { requestId });
        beginInvocationStarted = true;
        const response = await this.#storage(
          draft,
          [
            "parent",
            "begin",
            "--compatibility-key",
            compatibility.compatibilityKey,
            "--request-id",
            requestId,
          ],
          requestId,
          signal,
          workspaceStorageSha256,
        );
        parent = response.parent;
        if (parent === undefined) {
          const begunState = await this.#recordBegunResponse(setupId, draft, journal, response);
          transactionId = begunState.transactionId;
          projectRoot = begunState.projectRoot;
          const { stagingPath, libraryBefore } = begunState;
          await this.#prepareShell(draft, projectRoot, compatibility.bridgeOverlayDigest);
          await journal.append("parent.shell-prepared", { projectRoot });
          let unityStartedEventId: string | undefined;
          const unityResult = await this.processContainment.run(
            {
              command: { command: path.resolve(draft.unityPath) },
              args: [
                "-batchmode",
                "-nographics",
                "-quit",
                "-projectPath",
                projectRoot,
                "-buildTarget",
                "StandaloneWindows64",
                "-logFile",
                path.join(directory, "unity-parent.log"),
              ],
              cwd: projectRoot,
              timeoutMs: 30 * 60_000,
              signal,
              maxOutputBytes: MAX_COMMAND_BYTES,
            },
            {
              onStarted: async (pid, metadata) => {
                const processIdentity = await this.processContainment.captureIdentity(pid);
                const event = await journal.append("unity.started", {
                  pid,
                  ...(processIdentity === undefined ? {} : { processIdentity }),
                  ...(metadata?.containment === undefined
                    ? {}
                    : { containment: metadata.containment }),
                });
                unityStartedEventId = event.eventId;
              },
              onRegistered: async () => {
                if (unityStartedEventId === undefined) {
                  throw new Error("Unity containment registered without a durable start event.");
                }
                await journal.append("unity.containment-registered", {
                  startedEventId: unityStartedEventId,
                });
              },
              onExited: async (observation) => {
                if (unityStartedEventId === undefined) {
                  throw new Error("Unity exited without a durable start event.");
                }
                await journal.append("unity.exited", {
                  ...observation,
                  startedEventId: unityStartedEventId,
                });
              },
            },
          );
          if (unityStartedEventId === undefined) {
            throw new Error("Unity process did not cross the durable start boundary.");
          }
          await journal.append("unity.containment-drained", {
            startedEventId: unityStartedEventId,
          });
          if (
            unityResult.termination !== "exited" ||
            unityResult.exitCode !== 0 ||
            unityResult.signal !== null
          ) {
            throw new Error("Pinned Unity failed while building the immutable parent.");
          }
          if ((await fullSourceDigest(draft.projectPath)) !== sourceBefore) {
            throw new Error("The original Unity project changed during parent creation.");
          }
          if (compatibility.bridgeOverlayDigest !== undefined) {
            const bridgeTarget = path.join(projectRoot, "Packages", "com.testplay.bridge");
            if ((await hashTree(bridgeTarget)) !== compatibility.bridgeOverlayDigest) {
              throw new Error("The staged Bridge overlay changed during parent creation.");
            }
          }
          const libraryAfter = await stat(stagingPath);
          if (libraryAfter.dev !== libraryBefore.dev || libraryAfter.ino !== libraryBefore.ino) {
            throw new Error("The storage-owned Library mount identity changed.");
          }
          if ((await readdir(stagingPath)).length === 0) {
            throw new Error("Unity did not populate the Library mount.");
          }
          await journal.append("parent.validated", {
            transactionId,
            compatibilityKey: compatibility.compatibilityKey,
          });
        }
      }

      if (signal.aborted) throw new Error("setup.cancelled");
      if (parent === undefined) {
        if (transactionId === undefined) throw new Error("Parent transaction identity is missing.");
        const requestId = `setup-${setupId}-parent-commit`;
        await journal.append("parent.commit-started", { requestId, transactionId });
        const response = await this.#storage(
          draft,
          ["parent", "commit", "--transaction-id", transactionId, "--request-id", requestId],
          requestId,
          signal,
          workspaceStorageSha256,
        );
        parent = response.parent;
      }
      if (
        parent?.parentId === undefined ||
        parent.compatibilityKey !== compatibility.compatibilityKey ||
        parent.immutable !== true ||
        parent.provider === undefined
      ) {
        throw new Error("Committed parent identity is invalid.");
      }
      const committedPayload = {
        parentId: parent.parentId,
        compatibilityKey: compatibility.compatibilityKey,
        provider: parent.provider,
        unityVersion: compatibility.inputs.unityVersion,
        unitySha256: compatibility.inputs.unityExecutableSha256,
        ...(testplaySha256 === undefined ? {} : { testplaySha256 }),
        workspaceStorageSha256,
        ...(compatibility.bridgeOverlayDigest === undefined
          ? {}
          : { bridgeOverlayDigest: compatibility.bridgeOverlayDigest }),
      };
      await journal.append("parent.committed", committedPayload);
      committedParentExists = true;
      transactionId = undefined;
      const committedProjectRoot = projectRoot;
      projectRoot = undefined;
      if (committedProjectRoot !== undefined) {
        await this.#cleanupOwnedShell(
          committedProjectRoot,
          path.resolve(draft.workspaceRoot),
          setupId,
        );
        await journal.append("parent.shell-cleaned", { projectRoot: committedProjectRoot });
      }
      await this.#finishProfile(setupId, draft, journal, committedPayload, compatibility.inputs);
    } catch (error) {
      if (
        transactionId === undefined &&
        beginInvocationStarted &&
        ambiguousBeginRequestId !== undefined &&
        compatibilityKey !== undefined &&
        pinnedStorageSha256 !== undefined
      ) {
        try {
          const recovered = await this.#storage(
            draft,
            [
              "parent",
              "begin",
              "--compatibility-key",
              compatibilityKey,
              "--request-id",
              ambiguousBeginRequestId,
            ],
            ambiguousBeginRequestId,
            new AbortController().signal,
            pinnedStorageSha256,
          );
          if (recovered.parent === undefined) {
            const begunState = await this.#recordBegunResponse(setupId, draft, journal, recovered);
            transactionId = begunState.transactionId;
            projectRoot = begunState.projectRoot;
          }
        } catch {
          await journal.append("setup.recovery-required", {
            errorCode: "setup.parent-begin-uncertain",
          });
          return;
        }
      }
      if (transactionId !== undefined && projectRoot !== undefined) {
        if (pinnedStorageSha256 === undefined) {
          await journal.append("setup.recovery-required", {
            errorCode: "setup.storage-pin-unavailable",
          });
          return;
        }
        try {
          await this.#abortParent(
            setupId,
            draft,
            journal,
            transactionId,
            projectRoot,
            pinnedStorageSha256,
          );
        } catch {
          await journal.append("setup.recovery-required", {
            errorCode: "setup.parent-abort-uncertain",
          });
          return;
        }
      }
      if (committedParentExists) {
        await journal.append("setup.recovery-required", {
          errorCode: "setup.profile-store-incomplete",
        });
        return;
      }
      const cancelled =
        signal.aborted || (error instanceof Error && error.message === "setup.cancelled");
      await journal.append(cancelled ? "setup.cancelled" : "setup.failed", {
        errorCode: cancelled ? "setup.cancelled" : "setup.provisioning-failed",
      });
    }
  }

  async #prepareShell(
    draft: DesktopSetupDraftV1,
    projectRoot: string,
    bridgeDigest?: string,
  ): Promise<void> {
    for (const directory of PROJECT_DIRECTORIES) {
      await copyTree(path.join(draft.projectPath, directory), path.join(projectRoot, directory));
    }
    if (draft.bridgeOverlayPath === undefined || bridgeDigest === undefined) return;
    const bridgeTarget = path.join(projectRoot, "Packages", "com.testplay.bridge");
    try {
      await lstat(bridgeTarget);
      throw new Error("The project already contains com.testplay.bridge.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await copyTree(path.resolve(draft.bridgeOverlayPath), bridgeTarget);
    if ((await hashTree(bridgeTarget)) !== bridgeDigest) {
      throw new Error("Bridge copy failed verification.");
    }
  }

  async #cancelRequested(directory: string): Promise<boolean> {
    try {
      const entry = await lstat(path.join(directory, "cancel.requested"));
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Setup cancellation marker is not a real file.");
      }
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async #recordBegunResponse(
    setupId: string,
    draft: DesktopSetupDraftV1,
    journal: SetupJournal,
    response: StorageResponse,
  ): Promise<
    Readonly<{
      transactionId: string;
      stagingPath: string;
      projectRoot: string;
      libraryBefore: Awaited<ReturnType<typeof stat>>;
    }>
  > {
    if (response.transactionId === undefined || response.stagingPath === undefined) {
      throw new Error("parent begin returned neither a parent nor a staging transaction.");
    }
    const stagingPath = path.resolve(response.stagingPath);
    if (path.basename(stagingPath).toLowerCase() !== "library") {
      throw new Error("parent begin stagingPath is not the Library mount.");
    }
    const projectRoot = path.dirname(stagingPath);
    await validateStagingProjectRoot(projectRoot, draft.workspaceRoot);
    const libraryBefore = await stat(stagingPath);
    if (!libraryBefore.isDirectory()) throw new Error("staging Library is not mounted.");
    await this.#claimShell(projectRoot, setupId);
    await journal.append("parent.begun", {
      transactionId: response.transactionId,
      stagingPath,
      projectRoot,
      libraryDevice: libraryBefore.dev,
      libraryInode: libraryBefore.ino,
    });
    return { transactionId: response.transactionId, stagingPath, projectRoot, libraryBefore };
  }

  async #claimShell(projectRoot: string, setupId: string): Promise<void> {
    const markerPath = path.join(projectRoot, ".honeybee-setup-owner.json");
    const expected = { schemaVersion: 1, setupId } as const;
    try {
      await publishExclusiveFile(markerPath, JSON.stringify(expected));
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const markerEntry = await lstat(markerPath);
    if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
      throw new Error("Setup shell ownership marker is not a real file.");
    }
    const existing = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    if (existing.schemaVersion !== expected.schemaVersion || existing.setupId !== setupId) {
      throw new Error("Setup shell is owned by another transaction.");
    }
  }

  async #abortParent(
    setupId: string,
    draft: DesktopSetupDraftV1,
    journal: SetupJournal,
    transactionId: string,
    projectRoot: string,
    expectedStorageSha256: string,
  ): Promise<void> {
    const requestId = `setup-${setupId}-parent-abort-${sha256(transactionId).slice(0, 12)}`;
    await journal.append("parent.abort-started", { requestId, transactionId });
    await this.#storage(
      draft,
      ["parent", "abort", "--transaction-id", transactionId, "--request-id", requestId],
      requestId,
      new AbortController().signal,
      expectedStorageSha256,
    );
    await this.#cleanupOwnedShell(projectRoot, path.resolve(draft.workspaceRoot), setupId);
    await journal.append("parent.aborted", { transactionId });
  }

  async #drainInterruptedUnity(
    events: readonly SetupEvent[],
    journal: SetupJournal,
  ): Promise<void> {
    for (const started of events.filter((event) => event.type === "unity.started")) {
      const drained = events.some(
        (event) =>
          event.type === "unity.containment-drained" &&
          event.payload.startedEventId === started.eventId,
      );
      if (drained) continue;
      const registered = events.some(
        (event) =>
          event.type === "unity.containment-registered" &&
          event.payload.startedEventId === started.eventId,
      );
      const exited = events.some(
        (event) =>
          event.type === "unity.exited" && event.payload.startedEventId === started.eventId,
      );
      const pid = started.payload.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("The durable Unity containment PID is invalid.");
      }
      const processIdentity =
        typeof started.payload.processIdentity === "string"
          ? started.payload.processIdentity
          : undefined;
      await this.processContainment.drain(
        pid,
        processIdentity,
        !registered || exited ? "safe" : "unsafe",
      );
      await journal.append("unity.containment-drained", { startedEventId: started.eventId });
    }
  }

  async #cleanupOwnedShell(
    projectRoot: string,
    workspaceRoot: string,
    setupId: string,
  ): Promise<void> {
    try {
      await lstat(projectRoot);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await validateStagingProjectRoot(projectRoot, workspaceRoot);
    const markerPath = path.join(projectRoot, ".honeybee-setup-owner.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      schemaVersion?: unknown;
      setupId?: unknown;
    };
    if (marker.schemaVersion !== 1 || marker.setupId !== setupId) {
      throw new Error("Setup shell ownership could not be proven.");
    }
    try {
      await lstat(path.join(projectRoot, "Library"));
      throw new Error("Storage still owns the staging Library mount.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rm(projectRoot, { recursive: true, force: true });
    // Library was proven absent before removing the marker-owned project shell.
  }

  async #storage(
    draft: DesktopSetupDraftV1,
    args: readonly string[],
    requestId: string,
    signal: AbortSignal,
    expectedSha256: string,
  ): Promise<StorageResponse> {
    if ((await hashFile(draft.workspaceStoragePath)) !== expectedSha256) {
      throw new Error("workspace-storage no longer matches the durable setup pin.");
    }
    const result = await this.executeCommand(path.resolve(draft.workspaceStoragePath), args, {
      cwd: path.dirname(path.resolve(draft.workspaceStoragePath)),
      timeoutMs: 120_000,
      signal,
    });
    if (expectedSha256 !== (await hashFile(draft.workspaceStoragePath))) {
      throw new Error("workspace-storage changed during invocation.");
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new Error("workspace-storage command failed.");
    }
    return storageResponse(result.stdout, requestId);
  }

  async #finishProfile(
    setupId: string,
    draft: DesktopSetupDraftV1,
    journal: SetupJournal,
    committed: Record<string, unknown>,
    knownInputs?: ManagedUnityEnvironmentV1["compatibilityInputs"],
  ): Promise<void> {
    const profilePath = path.join(this.#directory(setupId), "profile.json");
    try {
      const profile = DesktopProjectProfileV2Schema.parse(
        JSON.parse(await readFile(profilePath, "utf8")),
      );
      await this.onProfile(profile);
      if ((await journal.events()).at(-1)?.type !== "setup.completed") {
        await journal.append("setup.completed", { profileId: profile.profileId });
      }
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const computed = await computeUnityCompatibility(
      draft.projectPath,
      draft.unityPath,
      draft.bridgeOverlayPath,
    );
    const inputs = knownInputs ?? computed.inputs;
    const environment = ManagedUnityEnvironmentV1Schema.parse({
      schemaVersion: 1,
      environmentId: randomUUID(),
      projectPath: path.resolve(draft.projectPath),
      unity: {
        path: path.resolve(draft.unityPath),
        version: String(committed.unityVersion ?? inputs.unityVersion),
        sha256: String(committed.unitySha256 ?? inputs.unityExecutableSha256),
      },
      ...(draft.testplayPath === undefined
        ? {}
        : {
            testplay: {
              path: path.resolve(draft.testplayPath),
              sha256: String(committed.testplaySha256 ?? (await hashFile(draft.testplayPath))),
            },
          }),
      workspaceStorage: {
        path: path.resolve(draft.workspaceStoragePath),
        sha256: String(
          committed.workspaceStorageSha256 ?? (await hashFile(draft.workspaceStoragePath)),
        ),
        workspaceRoot: path.resolve(draft.workspaceRoot),
        provider: String(committed.provider),
        parentId: String(committed.parentId),
        compatibilityKey: String(committed.compatibilityKey),
      },
      agent: draft.agent,
      ...(draft.bridgeOverlayPath === undefined
        ? {}
        : {
            bridgeOverlay: {
              packageName: "com.testplay.bridge" as const,
              sourcePath: path.resolve(draft.bridgeOverlayPath),
              digest: String(committed.bridgeOverlayDigest ?? computed.bridgeOverlayDigest),
            },
          }),
      editorPool: { id: "unity-editor", capacity: draft.editorCapacity },
      compatibilityInputs: inputs,
      configuredAt: new Date().toISOString(),
    });
    const configPath = path.join(this.#directory(setupId), "runtime-config.json");
    const config = managedRuntimeConfig(environment);
    await publishIdempotentFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const profile = DesktopProjectProfileV2Schema.parse({
      schemaVersion: 2,
      profileId: randomUUID(),
      label: draft.label,
      projectPath: environment.projectPath,
      batchConfigPath: configPath,
      configLabel: "Managed environment",
      lastOpenedAt: new Date().toISOString(),
      environment,
    });
    await publishExclusiveFile(profilePath, JSON.stringify(profile));
    await this.onProfile(profile);
    await journal.append("profile.stored", { profileId: profile.profileId });
    await journal.append("setup.completed", { profileId: profile.profileId });
  }

  #directory(setupId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(setupId)) throw new Error("Invalid setup ID.");
    return path.join(this.root, setupId);
  }

  #message(type: SetupEventType): string {
    const messages: Record<SetupEventType, string> = {
      "setup.started": "Setup request saved.",
      "setup.validated": "Project and pinned tools validated.",
      "parent.begin-started": "Requesting an immutable Library parent.",
      "parent.begun": "Storage-owned Library staging mount acquired.",
      "parent.shell-prepared": "Unity project shell and Bridge overlay prepared.",
      "unity.started": "Pinned Unity is building the reusable Library.",
      "unity.containment-registered": "Unity process containment registered durably.",
      "unity.exited": "Unity parent build exited.",
      "unity.containment-drained": "Unity process tree drained.",
      "parent.validated": "Library parent and original source verified.",
      "parent.commit-started": "Publishing the immutable parent.",
      "parent.committed": "Immutable parent committed.",
      "parent.shell-cleaned": "Parent staging project shell removed with residual zero.",
      "parent.abort-started": "Cleaning up the parent transaction.",
      "parent.aborted": "Parent transaction cleaned up.",
      "profile.stored": "Managed environment profile stored.",
      "setup.completed": "HoneyBee is ready for this project.",
      "setup.failed": "Setup failed before the environment became usable.",
      "setup.cancelled": "Setup was cancelled and cleaned up.",
      "setup.recovery-required": "Setup cleanup requires Resume.",
    };
    return messages[type];
  }
}

export const installBundledWorkspaceStorage = async (
  storageHostPathValue: string,
  workspaceRootValue: string,
): Promise<void> => {
  if (process.platform !== "win32") {
    throw setupError(
      "workspace-storage.install-unsupported",
      "Elevated workspace storage installation is currently available on Windows.",
    );
  }
  const storageHostPath = path.resolve(storageHostPathValue);
  const workspaceRoot = path.resolve(workspaceRootValue);
  assertPinnedNativeExecutable(storageHostPath, "HoneyBee workspace-storage host");
  const pinned = await hashFile(storageHostPath);
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `$process=Start-Process -FilePath ${quote(storageHostPath)} -ArgumentList @('install','--workspace-root',${quote(workspaceRoot)},'--user-sid',$sid) -Verb RunAs -Wait -PassThru`,
    "exit $process.ExitCode",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { cwd: path.dirname(storageHostPath), timeoutMs: 10 * 60_000 },
  );
  if (result.exitCode !== 0 || result.signal !== null) {
    throw setupError(
      "workspace-storage.install-failed",
      "Storage installation was cancelled or failed.",
    );
  }
  if ((await hashFile(storageHostPath)) !== pinned) {
    throw setupError(
      "workspace-storage.integrity-failed",
      "HoneyBee workspace-storage host changed during installation.",
    );
  }
};

export const validateManagedEnvironment = async (
  profile: DesktopProjectProfileV2,
): Promise<void> => {
  const environment = profile.environment;
  if ((environment.testplay === undefined) !== (environment.bridgeOverlay === undefined)) {
    throw setupError(
      "setup.profile-invalid",
      "TestPlay and its Bridge overlay must be configured together.",
    );
  }
  const compatibility = await computeUnityCompatibility(
    environment.projectPath,
    environment.unity.path,
    environment.bridgeOverlay?.sourcePath,
  );
  if (
    compatibility.compatibilityKey !== environment.workspaceStorage.compatibilityKey ||
    canonicalJson(compatibility.inputs) !== canonicalJson(environment.compatibilityInputs) ||
    (environment.testplay !== undefined &&
      (await hashFile(environment.testplay.path)) !== environment.testplay.sha256) ||
    (await hashFile(environment.workspaceStorage.path)) !== environment.workspaceStorage.sha256
  ) {
    throw new Error(
      "The managed environment changed. Open Setup Center to provision a compatible parent.",
    );
  }
};

export const materializeImportedManagedProfile = async (
  rootValue: string,
  profileValue: DesktopProjectProfileV2,
): Promise<DesktopProjectProfileV2> => {
  const profile = DesktopProjectProfileV2Schema.parse(profileValue);
  await validateManagedEnvironment(profile);
  const root = path.resolve(rootValue);
  await mkdir(root, { recursive: true });
  const configPath = path.join(root, `${profile.environment.environmentId}.runtime.json`);
  await publishIdempotentFile(
    configPath,
    JSON.stringify(managedRuntimeConfig(profile.environment), null, 2) + "\n",
  );
  return DesktopProjectProfileV2Schema.parse({
    ...profile,
    batchConfigPath: configPath,
    lastOpenedAt: new Date().toISOString(),
  });
};
