import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  ArtifactViewV1Schema,
  DoctorReportV1Schema,
  EditorPoolSnapshotV1Schema,
  EditorRegistryViewV1Schema,
  PatchActionV1Schema,
  RunControlResultV1Schema,
  RunDetailV1Schema,
  RunSummaryV1Schema,
  RuntimeInfoV1Schema,
  RuntimeProjectProfileV1Schema,
  StartUnityWorksRequestV1Schema,
  StartUnityWorksRequestV2Schema,
  StartUnityWorksResultV1Schema,
  type PatchActionV1,
  type PatchControlResultV1,
  type ArtifactViewV1,
  type DoctorCheckV1,
  type DoctorReportV1,
  type EditorPoolSnapshotV1,
  type EditorRegistryViewV1,
  type RunControlResultV1,
  type RunDetailV1,
  type RunSummaryV1,
  type RuntimeInfoV1,
  type RuntimeProjectProfileV1,
  type StartUnityWorksRequestV1,
  type StartUnityWorksRequestV2,
  type StartUnityWorksResultV1,
  type VerifiedPatchViewV1,
} from "@honeybee/control-plane-contracts";
import {
  ArtifactIdSchema,
  ArtifactRefSchema,
  EventIdSchema,
  FailureMetadataSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  HoneyBeeCoreError,
  ResourceIdSchema,
  RunIdSchema,
  StepIdSchema,
  UnityBatchConfigV3Schema,
  UnityBatchConfigV4Schema,
  UnityEditorSlotIdSchema,
  UnityWorkConfigV2Schema,
  type AnyOrchestrationEvent,
  type AgentCommand,
  type AnyVersionedJournalReplay,
  type ArtifactRef,
  type RunId,
} from "@honeybee/core";

import { loadUnityBatchConfig } from "./config.js";
import { physicalPath, samePath } from "./path-safety.js";
import { FileUnityEditorPoolCoordinator } from "./unity-editor-pool.js";
import { FileOsUnityEditorRegistry } from "./unity-editor-registry.js";
import { FileUnityPatchControl } from "./unity-patch-control.js";
import { SystemUnityProcessControl } from "./process-control.js";
import { runCommand, UnityWorkspaceStorageCliAdapter } from "./unity-adapters.js";
import {
  assertUnityPathsDisjoint,
  createUnityEditorBatchWorkflow,
  createUnityEditorTransactionServices,
} from "./unity-runtime-services.js";

const RUNTIME_VERSION = "0.6.0";
const execFileAsync = promisify(execFile);
const TEXT_MEDIA_TYPES = new Set<ArtifactRef["mediaType"]>([
  "text/plain; charset=utf-8",
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/vnd.honeybee.unity-patch+json",
]);

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface RuntimeContainedProcessRequest {
  readonly command: AgentCommand;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeContainedProcessResult {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly termination: "exited" | "timed-out" | "output-limit" | "cancelled";
}

export interface RuntimeContainedProcessLifecycle {
  readonly onStarted?: (
    pid: number,
    metadata?: Readonly<{ containment?: "deferred-v1" }>,
  ) => Promise<void>;
  readonly onRegistered?: (pid: number) => Promise<void>;
  readonly onExited?: (
    observation: Omit<RuntimeContainedProcessResult, "stdout" | "stderr" | "termination">,
  ) => Promise<void>;
}

/**
 * A narrow public adapter for Desktop-owned bootstrap processes. It preserves
 * the same deferred-start and process-tree cleanup boundary as Unity Runs;
 * orchestration decisions remain outside this primitive.
 */
export class RuntimeProcessContainment {
  readonly #control = new SystemUnityProcessControl();

  public captureIdentity(pid: number): Promise<string | undefined> {
    return this.#control.captureIdentity(pid);
  }

  public drain(
    pid: number,
    processIdentity?: string,
    missingPolicy: "unsafe" | "safe" = "unsafe",
  ): Promise<"drained" | "missing"> {
    return this.#control.drain(pid, processIdentity, missingPolicy);
  }

  public run(
    request: RuntimeContainedProcessRequest,
    lifecycle: RuntimeContainedProcessLifecycle,
  ): Promise<RuntimeContainedProcessResult> {
    return runCommand(request.command, request.args, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      lifecycle,
      terminateTree: true,
      deferExecutionUntilStarted: true,
      ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const hashFile = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

const runDoctorCommand = async (
  command: AgentCommand,
  args: readonly string[],
): Promise<Readonly<{ stdout: string; stderr: string }>> => {
  const result = await execFileAsync(command.command, [...(command.args ?? []), ...args], {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const executableCandidates = (command: string, cwd?: string): readonly string[] => {
  if (path.isAbsolute(command)) return [path.normalize(command)];
  if (command.includes("/") || command.includes("\\")) {
    return [path.resolve(cwd ?? process.cwd(), command)];
  }
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  const suffixes =
    process.platform === "win32" &&
    extensions.some((extension) => command.toUpperCase().endsWith(extension.toUpperCase()))
      ? [""]
      : extensions;
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) =>
      suffixes.map((extension) =>
        path.join(entry, process.platform === "win32" ? command + extension : command),
      ),
    );
};

const resolveExecutable = async (command: string, cwd?: string): Promise<string | undefined> => {
  for (const candidate of executableCandidates(command, cwd)) {
    try {
      const entry = await lstat(candidate);
      if (entry.isFile()) return path.resolve(candidate);
    } catch {
      // Continue through PATH candidates without exposing filesystem errors.
    }
  }
  return undefined;
};

const collectArtifactRefs = (
  value: unknown,
  output = new Map<string, ArtifactRef>(),
): ArtifactRef[] => {
  const parsed = ArtifactRefSchema.safeParse(value);
  if (parsed.success) {
    output.set(parsed.data.artifactId, parsed.data);
    return [...output.values()];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactRefs(item, output);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectArtifactRefs(item, output);
  }
  return [...output.values()];
};

const eventArtifacts = (event: AnyOrchestrationEvent): ArtifactRef[] =>
  collectArtifactRefs(event.payload);

const storedArtifactRefs = (events: readonly AnyOrchestrationEvent[]): ArtifactRef[] =>
  events.flatMap((event) => {
    if (event.type !== "artifact.stored" || !isRecord(event.payload)) return [];
    const parsed = ArtifactRefSchema.safeParse(event.payload.artifact);
    return parsed.success ? [parsed.data] : [];
  });

const eventSummary = (event: AnyOrchestrationEvent): string => {
  const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
  if (event.type === "editor.pool-acquired" && typeof payload.slotId === "string") {
    return `${payload.slotId} leased`;
  }
  if (event.type.startsWith("capability.") && typeof payload.kind === "string") {
    return `${payload.kind} ${event.type.slice("capability.".length)}`;
  }
  if (event.type === "work.registered" && typeof payload.workId === "string") {
    return `Work ${payload.workId} registered`;
  }
  if (event.type === "work.finished" && typeof payload.workId === "string") {
    return `Work ${payload.workId} finished`;
  }
  return event.type.replaceAll(".", " ");
};

const modeFrom = (events: readonly AnyOrchestrationEvent[]): string => {
  const start = events[0];
  if (start?.type !== "workflow.started") return "unknown";
  if (start.schemaVersion === 3) return "unity-work-v1";
  const payload: Record<string, unknown> = isRecord(start.payload) ? start.payload : {};
  if (
    (start.schemaVersion === 4 || start.schemaVersion === 5) &&
    typeof payload.mode === "string"
  ) {
    return payload.mode;
  }
  return "workflow";
};

const linkageFrom = (
  events: readonly AnyOrchestrationEvent[],
): Pick<RunSummaryV1, "parentRunId" | "workId" | "priority"> => {
  const start = events[0];
  if (start?.schemaVersion !== 5 || start.type !== "workflow.started") return {};
  const payload: Record<string, unknown> = isRecord(start.payload) ? start.payload : {};
  const linkage = isRecord(payload.linkage) ? payload.linkage : undefined;
  if (linkage === undefined) return {};
  const parentRunId = RunIdSchema.safeParse(linkage.parentRunId);
  const workId = StepIdSchema.safeParse(linkage.workId);
  const priority =
    linkage.priority === "interactive" ||
    linkage.priority === "validation" ||
    linkage.priority === "background"
      ? linkage.priority
      : undefined;
  return {
    ...(parentRunId.success ? { parentRunId: parentRunId.data } : {}),
    ...(workId.success ? { workId: workId.data } : {}),
    ...(priority === undefined ? {} : { priority }),
  };
};

const failureFrom = (events: readonly AnyOrchestrationEvent[]) => {
  const failed = [...events].reverse().find((event) => event.type === "workflow.failed");
  if (failed === undefined) return undefined;
  const payload: Record<string, unknown> = isRecord(failed.payload) ? failed.payload : {};
  const parsed = FailureMetadataSchema.safeParse(payload.failure ?? payload);
  return parsed.success ? parsed.data : undefined;
};

const phaseFrom = (events: readonly AnyOrchestrationEvent[], status: string): string => {
  const latest = (type: string): number =>
    events.reduce((found, event, index) => (event.type === type ? index : found), -1);
  const acquiredIndex = latest("editor.pool-acquired");
  const releasedIndex = latest("editor.pool-released");
  if (latest("editor.pool-queued") > acquiredIndex) return "Waiting for Editor";
  const capability = [...events].reverse().find((event) => event.type.startsWith("capability."));
  if (capability !== undefined && capability.type === "capability.started") {
    return eventSummary(capability);
  }
  if (acquiredIndex > releasedIndex) {
    const acquired = events[acquiredIndex];
    const payload: Record<string, unknown> =
      acquired !== undefined && isRecord(acquired.payload) ? acquired.payload : {};
    if (latest("editor.bridge-bound") > acquiredIndex) return "Warm Bridge ready";
    if (typeof payload.slotId === "string") return `${payload.slotId} leased`;
  }
  if (latest("agent.started") > latest("agent.exited")) return "Agent running";
  if (latest("workspace.release-started") > latest("workspace.released")) return "Cleaning up";
  return status;
};

const assignedEditorFrom = (
  events: readonly AnyOrchestrationEvent[],
): RunSummaryV1["assignedEditor"] => {
  const acquired = [...events].reverse().find((event) => event.type === "editor.pool-acquired");
  const released = [...events].reverse().find((event) => event.type === "editor.pool-released");
  if (acquired === undefined || (released?.sequence ?? 0) > acquired.sequence) return undefined;
  const payload = acquired.payload;
  const parsed = isRecord(payload) ? UnityEditorSlotIdSchema.safeParse(payload.slotId) : undefined;
  return parsed?.success === true ? parsed.data : undefined;
};

const projectPathFromConfig = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.sourceProjectPath === "string") return value.sourceProjectPath;
  return isRecord(value.transaction) && typeof value.transaction.sourceProjectPath === "string"
    ? value.transaction.sourceProjectPath
    : undefined;
};

export interface HoneyBeeRuntimeFacadeOptions {
  readonly stateRoot: string;
  readonly now?: () => Date;
  readonly randomId?: () => string;
}

export class HoneyBeeRuntimeFacade {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #executions = new Set<Promise<void>>();

  public constructor(options: HoneyBeeRuntimeFacadeOptions) {
    this.#root = path.resolve(options.stateRoot);
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  public info(): RuntimeInfoV1 {
    return RuntimeInfoV1Schema.parse({
      schemaVersion: 1,
      apiVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      stateRoot: this.#root,
    });
  }

  public async doctor(profileValue: RuntimeProjectProfileV1): Promise<DoctorReportV1> {
    const profile = RuntimeProjectProfileV1Schema.parse(profileValue);
    const checks: DoctorCheckV1[] = [];
    const add = (check: DoctorCheckV1): void => {
      checks.push(check);
    };
    add({
      id: "honeybee.runtime",
      label: "HoneyBee runtime",
      status: "pass",
      code: "runtime.available",
      summary: `Runtime API v1 is available (${RUNTIME_VERSION}).`,
      version: RUNTIME_VERSION,
      target: this.#root,
    });

    let config:
      | ReturnType<typeof UnityBatchConfigV3Schema.parse>
      | ReturnType<typeof UnityBatchConfigV4Schema.parse>
      | undefined;
    try {
      const loaded = await loadUnityBatchConfig(profile.batchConfigPath);
      if (loaded.schemaVersion !== 3 && loaded.schemaVersion !== 4) throw new Error("not v0.6");
      config =
        loaded.schemaVersion === 4
          ? UnityBatchConfigV4Schema.parse(loaded)
          : UnityBatchConfigV3Schema.parse(loaded);
      add({
        id: "config.batch",
        label: "Unity batch config",
        status: "pass",
        code: "config.valid",
        summary: "The strict v0.6 batch configuration is valid.",
        target: path.resolve(profile.batchConfigPath),
      });
    } catch {
      add({
        id: "config.batch",
        label: "Unity batch config",
        status: "fail",
        code: "config.invalid",
        summary: "The selected file is not a valid v0.6 batch configuration.",
        target: path.resolve(profile.batchConfigPath),
      });
    }

    const projectPath = path.resolve(profile.projectPath);
    for (const directoryName of ["Assets", "Packages", "ProjectSettings"] as const) {
      const target = path.join(projectPath, directoryName);
      try {
        const entry = await lstat(target);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe");
        add({
          id: `project.${directoryName.toLowerCase()}`,
          label: `Unity ${directoryName}`,
          status: "pass",
          code: "project.directory-valid",
          summary: `${directoryName} is a real project directory.`,
          target,
        });
      } catch {
        add({
          id: `project.${directoryName.toLowerCase()}`,
          label: `Unity ${directoryName}`,
          status: "fail",
          code: "project.directory-invalid",
          summary: `${directoryName} is missing or is not a safe directory.`,
          target,
        });
      }
    }

    const projectVersionPath = path.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
    try {
      const metadata = await stat(projectVersionPath);
      if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("invalid");
      const content = await readFile(projectVersionPath, "utf8");
      const version = /^m_EditorVersion:\s*(\S+)/mu.exec(content)?.[1];
      if (version === undefined) throw new Error("missing");
      add({
        id: "project.unity-version",
        label: "Unity project version",
        status: "pass",
        code: "project.version-found",
        summary: "The Unity project version is readable.",
        target: projectVersionPath,
        version,
      });
    } catch {
      add({
        id: "project.unity-version",
        label: "Unity project version",
        status: "fail",
        code: "project.version-missing",
        summary: "ProjectVersion.txt is missing or invalid.",
        target: projectVersionPath,
      });
    }

    if (config !== undefined) {
      try {
        const [selected, configured] = await Promise.all([
          physicalPath(projectPath),
          physicalPath(config.transaction.sourceProjectPath),
        ]);
        if (!samePath(selected, configured)) throw new Error("mismatch");
        add({
          id: "project.config-binding",
          label: "Project/config binding",
          status: "pass",
          code: "project.binding-valid",
          summary: "The selected project matches the configuration source.",
          target: selected,
        });
      } catch {
        add({
          id: "project.config-binding",
          label: "Project/config binding",
          status: "fail",
          code: "project.binding-invalid",
          summary: "The selected project does not match the configuration source.",
          target: projectPath,
        });
      }

      try {
        await assertUnityPathsDisjoint(this.#root, config.transaction);
        add({
          id: "paths.isolation",
          label: "Path isolation",
          status: "pass",
          code: "paths.disjoint",
          summary: "Source, workspace, and runtime state roots are physically disjoint.",
        });
      } catch {
        add({
          id: "paths.isolation",
          label: "Path isolation",
          status: "fail",
          code: "paths.overlap",
          summary: "Source, workspace, and runtime state roots are not safely disjoint.",
        });
      }

      const storagePath = config.transaction.workspaceStorage.command.command;
      try {
        const actualDigest = await hashFile(storagePath);
        const expectedDigest = config.transaction.workspaceStorage.binarySha256;
        if (actualDigest !== expectedDigest) throw new Error("digest");
        add({
          id: "workspace-storage.binary",
          label: "workspace-storage",
          status: "pass",
          code: "binary.pin-valid",
          summary: "The workspace-storage executable matches its pinned digest.",
          target: storagePath,
          expectedDigest,
          actualDigest,
        });
      } catch {
        add({
          id: "workspace-storage.binary",
          label: "workspace-storage",
          status: "fail",
          code: "binary.pin-invalid",
          summary: "The workspace-storage executable is missing or its digest does not match.",
          target: storagePath,
          expectedDigest: config.transaction.workspaceStorage.binarySha256,
        });
      }

      if ("schemaVersion" in config.transaction.workspaceStorage) {
        const storage = config.transaction.workspaceStorage;
        try {
          const status = await new UnityWorkspaceStorageCliAdapter(
            storage.command,
            storage.provider,
            storage.binarySha256,
            2,
          ).status(`desktop-doctor-${randomUUID()}`, storage.workspaceRoot);
          if (
            !isRecord(status.status) ||
            status.status.manualRecoveryRequired === true ||
            status.status.capability === undefined
          ) {
            throw new Error("storage unavailable");
          }
          add({
            id: "workspace-storage.schema2",
            label: "workspace-storage service",
            status: "pass",
            code: "workspace-storage.schema2-ready",
            summary: "The schema-2 storage service is installed and ready.",
            target: storage.workspaceRoot,
          });
        } catch {
          add({
            id: "workspace-storage.schema2",
            label: "workspace-storage service",
            status: "fail",
            code: "workspace-storage.schema2-unavailable",
            summary: "The schema-2 storage service is unavailable or requires manual recovery.",
            target: storage.workspaceRoot,
          });
        }
      }

      const commandChecks = [
        ...(config.transaction.testplay === undefined
          ? []
          : [
              {
                id: "unity.editor",
                label: "Unity Editor",
                command: config.transaction.testplay.unityPath,
                cwd: undefined,
              },
              {
                id: "testplay.command",
                label: "TestPlay",
                command: config.transaction.testplay.command.command,
                cwd: config.transaction.testplay.command.cwd,
              },
            ]),
        {
          id: "agent.command",
          label: "Agent",
          command: config.transaction.agent.command.command,
          cwd: config.transaction.agent.command.cwd,
        },
      ];
      for (const candidate of commandChecks) {
        const resolved = await resolveExecutable(candidate.command, candidate.cwd);
        add(
          resolved === undefined
            ? {
                id: candidate.id,
                label: candidate.label,
                status: "fail",
                code: "command.unavailable",
                summary: `${candidate.label} cannot be resolved as an executable command.`,
                target: candidate.command,
              }
            : {
                id: candidate.id,
                label: candidate.label,
                status: "pass",
                code: "command.available",
                summary: `${candidate.label} is executable.`,
                target: resolved,
              },
        );
      }

      const testplay = config.transaction.testplay;
      if (testplay === undefined) {
        add({
          id: "testplay.protocol-v3",
          label: "TestPlay protocol v3",
          status: "warning",
          code: "testplay.not-configured",
          summary: "TestPlay is optional; compile and warm-test capabilities are unavailable.",
        });
      } else {
        const testplayCommand = testplay.command;
        try {
          const versionResult = await runDoctorCommand(testplayCommand, ["version"]);
          const versionValue = JSON.parse(versionResult.stdout.trim()) as unknown;
          if (!isRecord(versionValue) || typeof versionValue.version !== "string") {
            throw new Error("invalid version response");
          }
          const [compileHelp, warmTestHelp] = await Promise.all([
            runDoctorCommand(testplayCommand, ["capability", "compile", "--help"]),
            runDoctorCommand(testplayCommand, ["capability", "warm-test", "--help"]),
          ]);
          const compileSurface = compileHelp.stdout + compileHelp.stderr;
          const warmTestSurface = warmTestHelp.stdout + warmTestHelp.stderr;
          for (const required of [
            "--require-bridge-session",
            "--require-editor-pid",
            "--workspace-id",
            "--no-fallback",
          ]) {
            if (!compileSurface.includes(required) || !warmTestSurface.includes(required)) {
              throw new Error("missing protocol v3 flag");
            }
          }
          if (!warmTestSurface.includes("--filter") || !warmTestSurface.includes("--category")) {
            throw new Error("missing warm-test selectors");
          }
          add({
            id: "testplay.protocol-v3",
            label: "TestPlay protocol v3",
            status: "pass",
            code: "testplay.protocol-v3-available",
            summary: "TestPlay exposes strict compile and warm-test capability commands.",
            target: testplayCommand.command,
            version: versionValue.version,
          });
        } catch {
          add({
            id: "testplay.protocol-v3",
            label: "TestPlay protocol v3",
            status: "fail",
            code: "testplay.protocol-v3-unavailable",
            summary: "TestPlay does not expose the required protocol v3 capability surface.",
            target: testplayCommand.command,
          });
        }
      }
    }

    if (profile.agentProbe !== undefined) {
      try {
        await execFileAsync(profile.agentProbe.command, profile.agentProbe.args ?? [], {
          cwd: profile.agentProbe.cwd,
          timeout: profile.agentProbe.timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        add({
          id: "agent.probe",
          label: "Agent probe",
          status: "pass",
          code: "agent.probe-passed",
          summary: "The explicitly requested Agent probe exited successfully.",
        });
      } catch {
        add({
          id: "agent.probe",
          label: "Agent probe",
          status: "fail",
          code: "agent.probe-failed",
          summary: "The explicitly requested Agent probe did not exit successfully.",
        });
      }
    } else {
      add({
        id: "agent.probe",
        label: "Agent probe",
        status: "warning",
        code: "agent.probe-skipped",
        summary: "No Agent process was started because an explicit probe was not requested.",
      });
    }

    return DoctorReportV1Schema.parse({
      schemaVersion: 1,
      checkedAt: this.#now().toISOString(),
      projectPath,
      ok: !checks.some((check) => check.status === "fail"),
      checks,
    });
  }

  public async startUnityWorks(
    requestValue: StartUnityWorksRequestV1 | StartUnityWorksRequestV2,
  ): Promise<StartUnityWorksResultV1> {
    const request =
      requestValue.schemaVersion === 2
        ? StartUnityWorksRequestV2Schema.parse(requestValue)
        : StartUnityWorksRequestV1Schema.parse(requestValue);
    const loaded = await loadUnityBatchConfig(request.batchConfigPath);
    if (loaded.schemaVersion !== 3 && loaded.schemaVersion !== 4) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Desktop execution requires a v0.6 batch configuration.",
      );
    }
    const baseConfig =
      loaded.schemaVersion === 4
        ? UnityBatchConfigV4Schema.parse(loaded)
        : UnityBatchConfigV3Schema.parse(loaded);
    const [selectedProject, configuredProject] = await Promise.all([
      physicalPath(request.projectPath),
      physicalPath(baseConfig.transaction.sourceProjectPath),
    ]);
    if (!samePath(selectedProject, configuredProject)) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "The selected project does not match the batch configuration.",
      );
    }
    await assertUnityPathsDisjoint(this.#root, baseConfig.transaction);

    const runId = RunIdSchema.parse(this.#randomId());
    const repository = new FileRunRepository(this.#root);
    await repository.create(runId);
    const controls = new FileRunControl(this.#root);
    const lease = await controls.acquire(runId);
    const journal = new FileOrchestrationJournal(this.#root);
    const operation = (async (): Promise<void> => {
      try {
        const work = request.works[0];
        if (work === undefined) throw new Error("A Work is required.");
        if (request.works.length === 1) {
          const agent = "agent" in work ? work.agent : baseConfig.transaction.agent;
          const singleConfig = UnityWorkConfigV2Schema.parse({
            ...baseConfig.transaction,
            schemaVersion: 2,
            agent,
            ...(baseConfig.transaction.testplay === undefined
              ? {}
              : {
                  testplay: {
                    ...baseConfig.transaction.testplay,
                    bridgeProtocolVersion: 3,
                  },
                }),
            editorPool: baseConfig.editorPool,
            priority: work.priority,
            capabilities: work.capabilities,
          });
          const services = createUnityEditorTransactionServices(
            this.#root,
            singleConfig,
            journal,
            controls,
          );
          if (singleConfig.capabilities.length > 0) {
            await services.execution.pool.declare({
              poolId: singleConfig.editorPool.id,
              capacity: singleConfig.editorPool.capacity,
            });
          }
          await services.transaction.run(runId, work.task, singleConfig, services.execution);
          return;
        }
        const config = UnityBatchConfigV4Schema.parse({
          ...baseConfig,
          schemaVersion: 4,
          maxParallelWorks: request.maxParallelWorks,
          works: request.works.map((entry) => ({
            ...entry,
            agent: "agent" in entry ? entry.agent : baseConfig.transaction.agent,
          })),
        });
        await createUnityEditorBatchWorkflow(this.#root, config, journal, controls).run(
          runId,
          config,
        );
      } finally {
        await lease.release();
      }
    })();
    this.#track(operation);
    return StartUnityWorksResultV1Schema.parse({
      schemaVersion: 1,
      runId,
      status: "running",
      journalPath: path.join(this.#root, runId, "events.jsonl"),
    });
  }

  public async listRuns(options: Readonly<{ projectPath?: string }> = {}): Promise<RunSummaryV1[]> {
    const records = await new FileRunRepository(this.#root).list();
    const details = await Promise.all(
      records.map(async ({ runId }) => {
        try {
          return await this.getRunDetail(runId);
        } catch {
          return RunDetailV1Schema.parse({
            schemaVersion: 1,
            summary: {
              schemaVersion: 1,
              runId,
              mode: "unknown",
              status: "indeterminate",
              phase: "Indeterminate",
              terminal: false,
              executorPresent: false,
              allowedActions: [],
            },
            events: [],
            artifacts: [],
            message: "The Run could not be inspected safely.",
          });
        }
      }),
    );
    const filtered =
      options.projectPath === undefined
        ? details
        : (
            await Promise.all(
              details.map(async (detail) => ({
                detail,
                matches:
                  detail.summary.projectPath !== undefined &&
                  (await this.#samePhysicalPath(
                    detail.summary.projectPath,
                    options.projectPath as string,
                  )),
              })),
            )
          )
            .filter((entry) => entry.matches)
            .map((entry) => entry.detail);
    return filtered
      .map((detail) => detail.summary)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  public async getRunDetail(runIdValue: string): Promise<RunDetailV1> {
    const runId = RunIdSchema.parse(runIdValue);
    await new FileRunRepository(this.#root).open(runId);
    const controls = new FileRunControl(this.#root);
    const replay = await this.#replayStable(runId, controls);
    const executorPresent = await controls.executorPresent(runId);
    if (replay.status === "indeterminate") {
      return RunDetailV1Schema.parse({
        schemaVersion: 1,
        summary: {
          schemaVersion: 1,
          runId,
          mode: "unknown",
          status: "indeterminate",
          phase: "Indeterminate",
          terminal: false,
          executorPresent,
          allowedActions: [],
        },
        events: [],
        artifacts: [],
        message: replay.message,
      });
    }

    const events = replay.events as readonly AnyOrchestrationEvent[];
    const start = events[0];
    const mode = modeFrom(events);
    const linkage = linkageFrom(events);
    const terminal = replay.status === "terminal";
    const journalSchemaVersion = start?.schemaVersion;
    let status = terminal
      ? replay.terminal.type.slice("workflow.".length)
      : executorPresent
        ? "running"
        : (journalSchemaVersion ?? 0) >= 3
          ? "cleanup-pending"
          : "interrupted";
    let projectPath: string | undefined;
    let integrityMessage: string | undefined;
    try {
      projectPath = await this.#projectPathFor(runId, events);
    } catch {
      status = "indeterminate";
      integrityMessage = "A referenced configuration Artifact failed validation.";
    }
    const outcomeDecided = events.some((event) => event.type === "transaction.outcome-decided");
    const allowedActions =
      status === "indeterminate" || terminal || linkage.parentRunId !== undefined
        ? []
        : [
            ...(!outcomeDecided ? (["cancel"] as const) : []),
            ...(!executorPresent ? (["resume"] as const) : []),
          ];
    const artifacts = storedArtifactRefs(events);
    const assignedEditor = assignedEditorFrom(events);
    const summary = RunSummaryV1Schema.parse({
      schemaVersion: 1,
      runId,
      ...(journalSchemaVersion === undefined ? {} : { journalSchemaVersion }),
      mode,
      status,
      phase: status === "indeterminate" ? "Indeterminate" : phaseFrom(events, status),
      ...(start === undefined ? {} : { startedAt: start.timestamp }),
      ...(events.at(-1) === undefined ? {} : { updatedAt: events.at(-1)?.timestamp }),
      terminal: terminal && status !== "indeterminate",
      executorPresent,
      ...(projectPath === undefined ? {} : { projectPath }),
      ...linkage,
      ...(assignedEditor === undefined ? {} : { assignedEditor }),
      allowedActions,
    });
    const failure = failureFrom(events);
    return RunDetailV1Schema.parse({
      schemaVersion: 1,
      summary,
      events: events.map((event) => ({
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        summary: eventSummary(event),
        artifacts: eventArtifacts(event),
      })),
      artifacts,
      ...(failure === undefined ? {} : { failure }),
      ...(integrityMessage === undefined ? {} : { message: integrityMessage }),
    });
  }

  public async resume(runIdValue: string): Promise<RunControlResultV1> {
    const runId = RunIdSchema.parse(runIdValue);
    const detail = await this.getRunDetail(runId);
    if (!detail.summary.allowedActions.includes("resume")) {
      throw new HoneyBeeCoreError("run.not-resumable", "This Run cannot be resumed.");
    }
    const controls = new FileRunControl(this.#root);
    const lease = await controls.acquire(runId);
    let ownershipTransferred = false;
    try {
      const journal = new FileOrchestrationJournal(this.#root);
      const replay = await journal.replay(runId);
      if (replay.status !== "active") {
        throw new HoneyBeeCoreError("run.not-resumable", "This Run is not active.");
      }
      const start = replay.events[0];
      if (start?.schemaVersion !== 5 || start.type !== "workflow.started") {
        throw new HoneyBeeCoreError(
          "run.not-resumable",
          "The Desktop facade resumes v0.6 Unity Runs only.",
        );
      }
      const payload: Record<string, unknown> = isRecord(start.payload) ? start.payload : {};
      const configRef = ArtifactRefSchema.parse(payload.config);
      const configValue = JSON.parse(
        await new FileArtifactStore(this.#root).get({ runId, artifact: configRef }),
      ) as unknown;
      const operation = (async (): Promise<void> => {
        try {
          if (payload.mode === "unity-batch-v2") {
            const config = UnityBatchConfigV3Schema.parse(configValue);
            await assertUnityPathsDisjoint(this.#root, config.transaction);
            await createUnityEditorBatchWorkflow(this.#root, config, journal, controls).resume(
              runId,
            );
            return;
          }
          const linkage = isRecord(payload.linkage) ? payload.linkage : undefined;
          if (linkage?.parentRunId !== undefined) {
            throw new HoneyBeeCoreError(
              "batch.child-managed",
              "A batch child can only be resumed through its parent Run.",
            );
          }
          const config = UnityWorkConfigV2Schema.parse(configValue);
          await assertUnityPathsDisjoint(this.#root, config);
          const services = createUnityEditorTransactionServices(
            this.#root,
            config,
            journal,
            controls,
          );
          await services.transaction.resume(runId, config, services.execution);
        } finally {
          await lease.release();
        }
      })();
      this.#track(operation);
      ownershipTransferred = true;
      return RunControlResultV1Schema.parse({
        schemaVersion: 1,
        runId,
        action: "resume",
        disposition: "started",
        executorPresent: true,
        requiresResume: false,
      });
    } catch (error) {
      if (!ownershipTransferred) await lease.release();
      throw error;
    }
  }

  public async cancel(runIdValue: string): Promise<RunControlResultV1> {
    const runId = RunIdSchema.parse(runIdValue);
    const detail = await this.getRunDetail(runId);
    if (!detail.summary.allowedActions.includes("cancel")) {
      throw new HoneyBeeCoreError("run.terminal", "This Run cannot be cancelled.");
    }
    const controls = new FileRunControl(this.#root);
    const requestId = EventIdSchema.parse(this.#randomId());
    await controls.submit({
      requestId,
      runId,
      action: "cancel",
      timestamp: this.#now().toISOString(),
    });
    const executorPresent = await controls.executorPresent(runId);
    return RunControlResultV1Schema.parse({
      schemaVersion: 1,
      runId,
      requestId,
      action: "cancel",
      disposition: executorPresent ? "queued" : "queued-awaiting-executor",
      executorPresent,
      requiresResume: !executorPresent,
    });
  }

  public async listEditors(): Promise<EditorRegistryViewV1> {
    const editors = await new FileOsUnityEditorRegistry(this.#root).list();
    return EditorRegistryViewV1Schema.parse({ schemaVersion: 1, editors });
  }

  public async inspectEditorPool(poolIdValue: string): Promise<EditorPoolSnapshotV1> {
    const poolId = ResourceIdSchema.parse(poolIdValue);
    const snapshot = await new FileUnityEditorPoolCoordinator(this.#root).inspect(poolId);
    return EditorPoolSnapshotV1Schema.parse({
      schemaVersion: 1,
      poolId,
      capacity: snapshot.capacity,
      active: snapshot.active.map(({ poolId: _poolId, ...lease }) => lease),
      queued: snapshot.queued.map(({ poolId: _poolId, ...ticket }) => ticket),
    });
  }

  public async inspectEditorPoolForConfig(configPath: string): Promise<EditorPoolSnapshotV1> {
    const loaded = await loadUnityBatchConfig(configPath);
    if (loaded.schemaVersion !== 3 && loaded.schemaVersion !== 4) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Editor pool inspection requires a v0.6 batch configuration.",
      );
    }
    const snapshot = await new FileUnityEditorPoolCoordinator(this.#root).inspectOptional(
      loaded.editorPool.id,
    );
    if (snapshot !== undefined) {
      return EditorPoolSnapshotV1Schema.parse({ schemaVersion: 1, ...snapshot });
    }
    return EditorPoolSnapshotV1Schema.parse({
      schemaVersion: 1,
      poolId: loaded.editorPool.id,
      capacity: loaded.editorPool.capacity,
      active: [],
      queued: [],
    });
  }

  public async readReferencedArtifact(
    runIdValue: string,
    artifactIdValue: string,
  ): Promise<ArtifactViewV1> {
    const runId = RunIdSchema.parse(runIdValue);
    const artifactId = ArtifactIdSchema.parse(artifactIdValue);
    await new FileRunRepository(this.#root).open(runId);
    const replay = await this.#replayStable(runId, new FileRunControl(this.#root));
    if (replay.status === "indeterminate") {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Artifacts cannot be authorized from an indeterminate Journal.",
      );
    }
    const artifacts = storedArtifactRefs(replay.events);
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (artifact === undefined) {
      throw new HoneyBeeCoreError(
        "artifact.read-failed",
        "The Artifact is not referenced by this Run Journal.",
      );
    }
    const bytes = Buffer.from(
      await new FileArtifactStore(this.#root).getBytes({ runId, artifact }),
    );
    const encoding = TEXT_MEDIA_TYPES.has(artifact.mediaType) ? "utf8" : "base64";
    return ArtifactViewV1Schema.parse({
      schemaVersion: 1,
      runId,
      artifact,
      encoding,
      content: bytes.toString(encoding),
    });
  }

  public async getVerifiedPatch(
    runIdValue: string,
    patchArtifactIdValue: string,
  ): Promise<VerifiedPatchViewV1> {
    const authorized = await this.#authorizedPatch(runIdValue, patchArtifactIdValue);
    return new FileUnityPatchControl(this.#root, this.#now).view(authorized);
  }

  public async controlVerifiedPatch(
    runIdValue: string,
    patchArtifactIdValue: string,
    actionValue: PatchActionV1,
  ): Promise<PatchControlResultV1> {
    const action = PatchActionV1Schema.parse(actionValue);
    const authorized = await this.#authorizedPatch(runIdValue, patchArtifactIdValue);
    return new FileUnityPatchControl(this.#root, this.#now).act({ ...authorized, action });
  }

  async #authorizedPatch(
    runIdValue: string,
    patchArtifactIdValue: string,
  ): Promise<Readonly<{ runId: RunId; patch: ArtifactRef; sourceProjectPath: string }>> {
    const runId = RunIdSchema.parse(runIdValue);
    const patchArtifactId = ArtifactIdSchema.parse(patchArtifactIdValue);
    const controls = new FileRunControl(this.#root);
    const replay = await this.#replayStable(runId, controls);
    if (replay.status !== "terminal" || replay.terminal.type !== "workflow.completed") {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Only a completed Run can dispose a verified patch.",
      );
    }
    const events = replay.events as readonly AnyOrchestrationEvent[];
    const patch = storedArtifactRefs(events).find(
      (artifact) =>
        artifact.artifactId === patchArtifactId && artifact.kind === "unity-verified-patch",
    );
    const sourceProjectPath = await this.#projectPathFor(runId, events);
    if (patch === undefined || sourceProjectPath === undefined) {
      throw new HoneyBeeCoreError(
        "artifact.read-failed",
        "The verified patch is not locally stored by this completed Run.",
      );
    }
    return { runId, patch, sourceProjectPath };
  }

  async #projectPathFor(
    runId: RunId,
    events: readonly AnyOrchestrationEvent[],
  ): Promise<string | undefined> {
    const start = events[0];
    if (start === undefined) return undefined;
    const config = eventArtifacts(start).find((artifact) => artifact.kind === "workflow-config");
    if (config === undefined) return undefined;
    const content = await new FileArtifactStore(this.#root).get({ runId, artifact: config });
    return projectPathFromConfig(JSON.parse(content) as unknown);
  }

  async #replayStable(runId: RunId, controls: FileRunControl): Promise<AnyVersionedJournalReplay> {
    const journal = new FileOrchestrationJournal(this.#root);
    let replay = await journal.replay(runId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await this.#journalFingerprint(runId);
      replay = await journal.replay(runId);
      const after = await this.#journalFingerprint(runId);
      const executorPresent = await controls.executorPresent(runId);
      if (before === after && (replay.status !== "indeterminate" || !executorPresent))
        return replay;
      await delay(25);
    }
    return replay;
  }

  async #journalFingerprint(runId: RunId): Promise<string> {
    try {
      const metadata = await stat(path.join(this.#root, runId, "events.jsonl"));
      return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "missing";
      throw error;
    }
  }

  async #samePhysicalPath(left: string, right: string): Promise<boolean> {
    try {
      const [physicalLeft, physicalRight] = await Promise.all([
        physicalPath(left),
        physicalPath(right),
      ]);
      return samePath(physicalLeft, physicalRight);
    } catch {
      return false;
    }
  }

  #track(operation: Promise<void>): void {
    const settled = operation
      .catch(() => undefined)
      .finally(() => this.#executions.delete(settled));
    this.#executions.add(settled);
  }
}
