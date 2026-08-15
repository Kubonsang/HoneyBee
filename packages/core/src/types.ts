import type {
  AnyOrchestrationEvent,
  ArtifactId,
  ArtifactKind,
  ArtifactMediaType,
  ArtifactRef,
  ContentDigest,
  FailureMetadata,
  OrchestrationEventV1,
  OrchestrationEventV2,
  OrchestrationEventV3,
  OrchestrationEventV4,
  PortName,
  RunId,
  StepId,
  TerminalWorkflowEvent,
  TerminalWorkflowEventV2,
  TerminalWorkflowEventV3,
  TerminalWorkflowEventV4,
  ControlRequest,
  WorkflowConfigV3,
  WorkflowStep,
} from "@honeybee/orchestration-contracts";

export interface AgentProcessRequest {
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly prompt: string;
  readonly command: WorkflowStep["agent"];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly cancelGraceMs?: number;
}

export interface AgentExitObservation {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDigest?: ContentDigest;
  readonly stderrDigest?: ContentDigest;
}

export interface AgentProcessLifecycle {
  readonly onStarted: (
    pid: number,
    metadata?: Readonly<{ containment?: "deferred-v1" }>,
  ) => Promise<void>;
  readonly onRegistered?: (pid: number) => Promise<void>;
  readonly onExited: (observation: AgentExitObservation) => Promise<void>;
}

export interface AgentProcessResult extends AgentExitObservation {
  readonly stepId: StepId;
  readonly command: string;
  readonly termination: "exited" | "timed-out" | "output-limit" | "cancelled";
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentProcessRunner {
  run(request: AgentProcessRequest, lifecycle: AgentProcessLifecycle): Promise<AgentProcessResult>;
}

export interface ArtifactPutRequest {
  readonly runId: RunId;
  readonly artifactId: ArtifactId;
  readonly kind: ArtifactKind;
  readonly mediaType: ArtifactMediaType;
  readonly content: string;
}

export interface ArtifactGetRequest {
  readonly runId: RunId;
  readonly artifact: ArtifactRef;
}

export interface ArtifactPutBytesRequest extends Omit<ArtifactPutRequest, "content"> {
  readonly content: Uint8Array;
}

export interface ArtifactStore {
  put(request: ArtifactPutRequest): Promise<ArtifactRef>;
  get(request: ArtifactGetRequest): Promise<string>;
  putBytes(request: ArtifactPutBytesRequest): Promise<ArtifactRef>;
  getBytes(request: ArtifactGetRequest): Promise<Uint8Array>;
}

export interface RunRecord {
  readonly runId: RunId;
}

export interface RunRepository {
  create(runId: RunId): Promise<void>;
  open(runId: RunId): Promise<RunRecord>;
  delete(runId: RunId): Promise<void>;
}

export type JournalReplay =
  | Readonly<{
      status: "terminal";
      events: readonly OrchestrationEventV1[];
      terminal: TerminalWorkflowEvent;
    }>
  | Readonly<{
      status: "indeterminate";
      code: "run.indeterminate";
      message: string;
    }>;

export interface OrchestrationJournal {
  append(runId: RunId, event: OrchestrationEventV1): Promise<void>;
  replay(runId: RunId): Promise<AnyVersionedJournalReplay>;
}

export type JournalReplayV2 =
  | Readonly<{
      status: "terminal";
      events: readonly OrchestrationEventV2[];
      terminal: TerminalWorkflowEventV2;
    }>
  | Readonly<{
      status: "active";
      events: readonly OrchestrationEventV2[];
    }>
  | Readonly<{
      status: "indeterminate";
      code: "run.indeterminate";
      message: string;
    }>;

export type AnyJournalReplay = JournalReplay | JournalReplayV2;

export type JournalReplayV3 =
  | Readonly<{
      status: "terminal";
      events: readonly OrchestrationEventV3[];
      terminal: TerminalWorkflowEventV3;
    }>
  | Readonly<{
      status: "active";
      events: readonly OrchestrationEventV3[];
    }>
  | Readonly<{
      status: "indeterminate";
      code: "run.indeterminate";
      message: string;
    }>;

export type JournalReplayV4 =
  | Readonly<{
      status: "terminal";
      events: readonly OrchestrationEventV4[];
      terminal: TerminalWorkflowEventV4;
    }>
  | Readonly<{
      status: "active";
      events: readonly OrchestrationEventV4[];
    }>
  | Readonly<{
      status: "indeterminate";
      code: "run.indeterminate";
      message: string;
    }>;

export type AnyVersionedJournalReplay = AnyJournalReplay | JournalReplayV3 | JournalReplayV4;

export interface VersionedOrchestrationJournal {
  append(runId: RunId, event: AnyOrchestrationEvent): Promise<void>;
  replay(runId: RunId): Promise<AnyVersionedJournalReplay>;
}

export interface RunControlPort {
  submit(request: ControlRequest): Promise<void>;
  pending(runId: RunId): Promise<readonly ControlRequest[]>;
  acknowledge(request: ControlRequest): Promise<void>;
  executorPresent(runId: RunId): Promise<boolean>;
}

export interface RunLease {
  release(): Promise<void>;
}

export interface RunLeaseManager extends RunControlPort {
  acquire(runId: RunId): Promise<RunLease>;
}

export interface DagWorkflowRunRequest {
  readonly runId: RunId;
  readonly task: string;
  readonly config: WorkflowConfigV3;
}

export type DagStepState =
  | "pending"
  | "ready"
  | "running"
  | "retry-wait"
  | "waiting-approval"
  | "completed"
  | "skipped"
  | "failed"
  | "blocked"
  | "escalated"
  | "interrupted"
  | "cancelled";

export interface DagStepResult {
  readonly stepId: StepId;
  readonly state: DagStepState;
  readonly attempt: number;
  readonly outputs: Readonly<Record<PortName, ArtifactRef>>;
  readonly input?: ArtifactRef;
  readonly pid?: number;
}

export type DagRunState =
  | "running"
  | "pausing"
  | "paused"
  | "waiting-approval"
  | "interrupted"
  | "cancelling"
  | "completed"
  | "failed"
  | "blocked"
  | "escalated"
  | "cancelled"
  | "indeterminate";

export interface DagWorkflowRunResult {
  readonly runId: RunId;
  readonly status: DagRunState;
  readonly task: ArtifactRef;
  readonly steps: readonly DagStepResult[];
  readonly outputs: Readonly<Record<StepId, Readonly<Record<PortName, ArtifactRef>>>>;
  readonly result?: string;
  readonly failure?: FailureMetadata;
}

export interface WorkflowRunRequest {
  readonly runId: RunId;
  readonly task: string;
  readonly steps: readonly WorkflowStep[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WorkflowStepResult {
  readonly stepId: StepId;
  readonly status: "completed" | "blocked" | "escalated";
  readonly pid: number;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly input: ArtifactRef;
  readonly output?: ArtifactRef;
  readonly reason?: ArtifactRef;
  readonly question?: ArtifactRef;
}

interface WorkflowRunResultBase {
  readonly runId: RunId;
  readonly task: ArtifactRef;
  readonly steps: readonly WorkflowStepResult[];
}

export type WorkflowRunResult =
  | (WorkflowRunResultBase &
      Readonly<{ status: "completed"; result: string; resultArtifact: ArtifactRef }>)
  | (WorkflowRunResultBase &
      Readonly<{ status: "blocked"; reason: string; reasonArtifact: ArtifactRef }>)
  | (WorkflowRunResultBase &
      Readonly<{
        status: "escalated";
        reason: string;
        question: string;
        reasonArtifact: ArtifactRef;
        questionArtifact: ArtifactRef;
      }>);

export interface OrchestrationWorkflowOptions {
  readonly now?: () => Date;
  readonly randomId?: () => string;
}

export type JournalFailureMetadata = FailureMetadata;
