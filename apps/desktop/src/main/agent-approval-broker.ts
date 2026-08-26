import path from "node:path";

import {
  AgentApprovalDecisionV1Schema,
  type AgentApprovalDecisionV1,
} from "@honeybee/orchestration-contracts";
import type { AgentApprovalPort } from "honeybee-cli/runtime";

import {
  DesktopPendingAgentApprovalV1Schema,
  type DesktopPendingAgentApprovalV1,
} from "../shared/ipc.js";

interface Pending {
  readonly view: DesktopPendingAgentApprovalV1;
  readonly resolve: (value: AgentApprovalDecisionV1) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const confined = (root: string, target: string): boolean => {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const pathCandidates = (value: unknown, output: string[] = []): readonly string[] => {
  if (Array.isArray(value)) {
    for (const item of value) pathCandidates(item, output);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === "string" &&
        (/^(?:file|target|source)?_?path$/iu.test(key) || /^file$/iu.test(key)) &&
        item.trim().length > 0
      ) {
        output.push(item);
      } else {
        pathCandidates(item, output);
      }
    }
  }
  return output;
};

export class DesktopAgentApprovalBroker implements AgentApprovalPort {
  readonly #pending = new Map<string, Pending>();

  public pending(): readonly DesktopPendingAgentApprovalV1[] {
    return [...this.#pending.values()]
      .map((entry) => entry.view)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  public async decide(
    request: Parameters<AgentApprovalPort["decide"]>[0],
  ): Promise<AgentApprovalDecisionV1> {
    const policy = this.#policy(request);
    if (policy !== undefined) return policy;
    const view = DesktopPendingAgentApprovalV1Schema.parse({
      schemaVersion: 1,
      approvalId: request.approvalId,
      runId: request.runId,
      stepId: request.stepId,
      kind: request.kind,
      summary: request.summary,
      requestedAt: new Date().toISOString(),
    });
    return new Promise<AgentApprovalDecisionV1>((resolve, reject) => {
      if (request.signal?.aborted === true) {
        reject(request.signal.reason ?? new Error("Approval was cancelled."));
        return;
      }
      const pending: Pending = {
        view,
        resolve,
        reject,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const abort = (): void => {
        this.#pending.delete(request.approvalId);
        reject(request.signal?.reason ?? new Error("Approval was cancelled."));
      };
      pending.abort = abort;
      request.signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(request.approvalId, pending);
    });
  }

  public respond(approvalId: string, decision: "allow-once" | "deny"): void {
    const pending = this.#pending.get(approvalId);
    if (pending === undefined) throw new Error("The Agent approval is no longer pending.");
    this.#pending.delete(approvalId);
    pending.signal?.removeEventListener("abort", pending.abort as () => void);
    pending.resolve(
      AgentApprovalDecisionV1Schema.parse({
        schemaVersion: 1,
        approvalId,
        decision,
        source: "user",
        decidedAt: new Date().toISOString(),
      }),
    );
  }

  #policy(
    request: Parameters<AgentApprovalPort["decide"]>[0],
  ): AgentApprovalDecisionV1 | undefined {
    let decision: "allow-once" | "deny" | undefined;
    if (request.kind === "permissions") {
      decision = "deny";
    } else if (request.kind === "file-change") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.serializedRequest) as unknown;
      } catch {
        parsed = undefined;
      }
      const candidates = pathCandidates(parsed);
      const mutable = ["Assets", "Packages", "ProjectSettings"].map((name) =>
        path.join(request.workspacePath, name),
      );
      if (
        candidates.length > 0 &&
        candidates.every((candidate) => {
          const target = path.isAbsolute(candidate)
            ? candidate
            : path.resolve(request.workspacePath, candidate);
          return (
            mutable.some((root) => confined(root, target)) &&
            !confined(path.join(request.workspacePath, "Packages", "com.testplay.bridge"), target)
          );
        })
      ) {
        decision = "allow-once";
      } else if (candidates.length > 0) {
        decision = "deny";
      }
    }
    return decision === undefined
      ? undefined
      : AgentApprovalDecisionV1Schema.parse({
          schemaVersion: 1,
          approvalId: request.approvalId,
          decision,
          source: "policy",
          decidedAt: new Date().toISOString(),
        });
  }
}
