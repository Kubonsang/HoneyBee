import type { UnityWorkPriority } from "@honeybee/orchestration-contracts";

export interface DesktopWorkAdmission {
  readonly priority: UnityWorkPriority;
  readonly signal?: AbortSignal;
  readonly onQueued?: () => Promise<void>;
  readonly onEntered?: (waitMs: number) => Promise<void>;
}

interface Ticket<T> {
  readonly sequence: number;
  readonly queuedAt: number;
  readonly request: DesktopWorkAdmission;
  readonly body: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  abort?: () => void;
}

const rank = (priority: UnityWorkPriority): number =>
  priority === "interactive" ? 0 : priority === "validation" ? 1 : 2;

/**
 * Process-local Desktop admission control. It deliberately owns no durable
 * resource and therefore has no acquire/release API: scope exit returns the
 * slot even when the body throws or is cancelled.
 */
export class DesktopWorkScheduler {
  readonly #capacity: number;
  readonly #now: () => number;
  #active = 0;
  #sequence = 0;
  readonly #queued: Ticket<unknown>[] = [];

  public constructor(capacity = 4, now: () => number = Date.now) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32) {
      throw new Error("Desktop Work scheduler capacity must be between 1 and 32.");
    }
    this.#capacity = capacity;
    this.#now = now;
  }

  public snapshot(): Readonly<{ capacity: number; active: number; queued: number }> {
    return { capacity: this.#capacity, active: this.#active, queued: this.#queued.length };
  }

  public async withSlot<T>(request: DesktopWorkAdmission, body: () => Promise<T>): Promise<T> {
    if (request.signal?.aborted === true) throw request.signal.reason ?? new Error("Aborted");
    return new Promise<T>((resolve, reject) => {
      const ticket: Ticket<T> = {
        sequence: ++this.#sequence,
        queuedAt: this.#now(),
        request,
        body,
        resolve,
        reject,
      };
      const abort = (): void => {
        const index = this.#queued.indexOf(ticket as Ticket<unknown>);
        if (index < 0) return;
        this.#queued.splice(index, 1);
        request.signal?.removeEventListener("abort", abort);
        reject(request.signal?.reason ?? new Error("Aborted"));
      };
      ticket.abort = abort;
      request.signal?.addEventListener("abort", abort, { once: true });
      this.#queued.push(ticket as Ticket<unknown>);
      this.#queued.sort(
        (left, right) =>
          rank(left.request.priority) - rank(right.request.priority) ||
          left.sequence - right.sequence,
      );
      void Promise.resolve(request.onQueued?.())
        .then(() => this.#drain())
        .catch((error: unknown) => {
          const index = this.#queued.indexOf(ticket as Ticket<unknown>);
          if (index >= 0) this.#queued.splice(index, 1);
          request.signal?.removeEventListener("abort", abort);
          reject(error);
          this.#drain();
        });
    });
  }

  #drain(): void {
    while (this.#active < this.#capacity) {
      const ticket = this.#queued.shift();
      if (ticket === undefined) return;
      ticket.request.signal?.removeEventListener("abort", ticket.abort as () => void);
      if (ticket.request.signal?.aborted === true) {
        ticket.reject(ticket.request.signal.reason ?? new Error("Aborted"));
        continue;
      }
      this.#active += 1;
      void Promise.resolve(ticket.request.onEntered?.(this.#now() - ticket.queuedAt))
        .then(ticket.body)
        .then(ticket.resolve, ticket.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }
}
