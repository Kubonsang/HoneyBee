import type {
  ArtifactId,
  ArtifactKind,
  ArtifactMediaType,
  ArtifactRef,
  ContentDigest,
  FailureMetadata,
  OrchestrationEventV1,
  RunId,
  StepId,
  TerminalWorkflowEvent,
  WorkflowStep,
} from "@honeybee/orchestration-contracts";

export interface AgentProcessRequest {
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly prompt: string;
  readonly command: WorkflowStep["agent"];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
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
  readonly onStarted: (pid: number) => Promise<void>;
  readonly onExited: (observation: AgentExitObservation) => Promise<void>;
}

export interface AgentProcessResult extends AgentExitObservation {
  readonly stepId: StepId;
  readonly command: string;
  readonly termination: "exited" | "timed-out" | "output-limit";
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

export interface ArtifactStore {
  put(request: ArtifactPutRequest): Promise<ArtifactRef>;
  get(request: ArtifactGetRequest): Promise<string>;
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
  replay(runId: RunId): Promise<JournalReplay>;
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
