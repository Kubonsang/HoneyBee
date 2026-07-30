import type {
  PromptDeliveryAttemptRepository,
  PromptDeliveryReceiptRepository,
  SessionRunRepository,
} from "@honeybee/persistence";

import type { ConsoleApplicationService } from "./console-service.js";

export type LifecycleState = "activating" | "active" | "shutting-down" | "stopped" | "failed";
export type ExtensionShutdownReason =
  "extension-deactivate" | "context-dispose" | "activation-failure";

export type ShutdownWarningCode =
  | "console-drain-failed"
  | "run-stopping-save-failed"
  | "run-timeout-finalize-failed"
  | "runtime-shutdown-failed"
  | "persistence-flush-failed"
  | "runtime-dispose-failed"
  | "shutdown-timeout";

export interface ShutdownReport {
  readonly reason: ExtensionShutdownReason;
  readonly status: "completed" | "timed-out" | "failed";
  readonly stoppedRuns: number;
  readonly unresolvedRuns: number;
  readonly persistenceFlushed: boolean;
  readonly runtimeDisposed: boolean;
  readonly warnings: readonly ShutdownWarningCode[];
}

interface ConsoleShutdownPort {
  beginShutdown(): void;
  markActiveRunsStopping(): Promise<void>;
  shutdownRuntime(reason: "extension-shutdown"): Promise<{
    readonly stoppedRuns: number;
    readonly unresolvedRuns: number;
  }>;
  interruptRemaining(reason: "shutdown-timeout"): Promise<number>;
  flushRunState(): Promise<void>;
  disposeRuntime(): Promise<void>;
  disposeListeners(): void;
}

interface ConsoleViewShutdownPort {
  shutdown(): Promise<void>;
}

interface FlushPort {
  flush(): Promise<void>;
}

export interface ExtensionLifecycleDependencies {
  readonly console: ConsoleShutdownPort;
  readonly view: ConsoleViewShutdownPort;
  readonly attempts: Pick<PromptDeliveryAttemptRepository, "flush">;
  readonly receipts: Pick<PromptDeliveryReceiptRepository, "flush">;
  readonly runs: Pick<SessionRunRepository, "flush">;
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly diagnostic?: (code: ShutdownWarningCode) => void;
}

type BoundedResult<T> =
  { readonly completed: true; readonly value: T } | { readonly completed: false };

const settleWithin = async <T>(work: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<BoundedResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ completed: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      work.then((value): BoundedResult<T> => ({ completed: true, value })),
      expired,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

/** Single idempotent owner for bounded Extension, Runtime and persistence shutdown. */
export class ExtensionLifecycleCoordinator {
  #state: LifecycleState = "activating";
  #shutdownPromise: Promise<ShutdownReport> | undefined;

  public constructor(private readonly dependencies: ExtensionLifecycleDependencies) {}

  public get state(): LifecycleState {
    return this.#state;
  }

  public activate(): void {
    if (this.#state !== "activating") return;
    this.#state = "active";
  }

  public shutdown(reason: ExtensionShutdownReason): Promise<ShutdownReport> {
    this.#shutdownPromise ??= this.#shutdown(reason);
    return this.#shutdownPromise;
  }

  async #shutdown(reason: ExtensionShutdownReason): Promise<ShutdownReport> {
    this.#state = "shutting-down";
    this.dependencies.console.beginShutdown();
    const timeoutMs = this.dependencies.timeoutMs ?? 5_000;
    const warnings: ShutdownWarningCode[] = [];
    let stoppedRuns = 0;
    let unresolvedRuns = 0;
    let persistenceFlushed = false;
    let runtimeDisposed = false;

    const work = (async (): Promise<void> => {
      try {
        await this.dependencies.view.shutdown();
      } catch {
        warnings.push("console-drain-failed");
      }
      try {
        await this.dependencies.console.markActiveRunsStopping();
      } catch {
        warnings.push("run-stopping-save-failed");
      }
      try {
        const runtime = await this.dependencies.console.shutdownRuntime("extension-shutdown");
        stoppedRuns = runtime.stoppedRuns;
        unresolvedRuns = runtime.unresolvedRuns;
      } catch {
        warnings.push("runtime-shutdown-failed");
      }
      try {
        const flushables: readonly FlushPort[] = [
          { flush: () => this.dependencies.console.flushRunState() },
          this.dependencies.runs,
          this.dependencies.attempts,
          this.dependencies.receipts,
        ];
        await Promise.all(flushables.map((repository) => repository.flush()));
        persistenceFlushed = true;
      } catch {
        warnings.push("persistence-flush-failed");
      }
      try {
        await this.dependencies.console.disposeRuntime();
        runtimeDisposed = true;
      } catch {
        warnings.push("runtime-dispose-failed");
      }
    })();

    const completed = await settleWithin(work, timeoutMs);
    if (!completed.completed) {
      warnings.push("shutdown-timeout");
      const cleanupTimeoutMs = this.dependencies.cleanupTimeoutMs ?? 1_000;
      try {
        const interrupted = await settleWithin(
          this.dependencies.console.interruptRemaining("shutdown-timeout"),
          cleanupTimeoutMs,
        );
        if (interrupted.completed) {
          unresolvedRuns = Math.max(unresolvedRuns, interrupted.value);
        } else {
          warnings.push("run-timeout-finalize-failed");
        }
      } catch {
        warnings.push("run-timeout-finalize-failed");
      }
      try {
        const disposed = await settleWithin(
          this.dependencies.console.disposeRuntime().then(() => true),
          cleanupTimeoutMs,
        );
        runtimeDisposed ||= disposed.completed && disposed.value;
        if (!disposed.completed) warnings.push("runtime-dispose-failed");
      } catch {
        warnings.push("runtime-dispose-failed");
      }
      void work.catch(() => undefined);
      this.finish(warnings);
      return {
        reason,
        status: "timed-out",
        stoppedRuns,
        unresolvedRuns,
        persistenceFlushed,
        runtimeDisposed,
        warnings: this.uniqueWarnings(warnings),
      };
    }

    const failed = warnings.length > 0;
    this.finish(warnings);
    return {
      reason,
      status: failed ? "failed" : "completed",
      stoppedRuns,
      unresolvedRuns,
      persistenceFlushed,
      runtimeDisposed,
      warnings: this.uniqueWarnings(warnings),
    };
  }

  private finish(warnings: readonly ShutdownWarningCode[]): void {
    this.dependencies.console.disposeListeners();
    for (const warning of this.uniqueWarnings(warnings)) this.dependencies.diagnostic?.(warning);
    this.#state = "stopped";
  }

  private uniqueWarnings(warnings: readonly ShutdownWarningCode[]): readonly ShutdownWarningCode[] {
    return [...new Set(warnings)];
  }
}

export const lifecycleConsolePort = (console: ConsoleApplicationService): ConsoleShutdownPort =>
  console;
