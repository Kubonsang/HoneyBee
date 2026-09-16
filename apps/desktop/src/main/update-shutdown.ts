import type { DesktopActivityDrain } from "./activity-drain.js";

/** Resolves consent after draining; transport flushes acknowledgment before quit. */
export class DesktopUpdateShutdown {
  #finish: ((status: "accepted" | "cancelled") => void) | undefined;
  constructor(
    private readonly drain: DesktopActivityDrain,
    private readonly confirm: () => boolean,
  ) {}
  get pending(): boolean {
    return this.#finish !== undefined;
  }
  drained(): void {
    if (this.#finish === undefined || !this.drain.requestQuit()) return;
    const accepted = this.confirm();
    if (!accepted) this.drain.cancelQuit();
    this.#finish(accepted ? "accepted" : "cancelled");
  }
  request(signal: AbortSignal): Promise<"accepted" | "cancelled"> {
    if (signal.aborted || this.pending) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      const abort = () => {
        this.drain.cancelQuit();
        finish("cancelled");
      };
      const finish = (status: "accepted" | "cancelled") => {
        signal.removeEventListener("abort", abort);
        this.#finish = undefined;
        resolve(status);
      };
      this.#finish = finish;
      signal.addEventListener("abort", abort, { once: true });
      this.drained();
    });
  }
}
