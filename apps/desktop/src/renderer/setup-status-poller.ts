import type { DesktopSetupStatusV1 } from "../shared/ipc.js";

interface SetupStatusPollerOptions {
  readonly setupId: string;
  readonly signal: AbortSignal;
  readonly readStatus: (setupId: string) => Promise<DesktopSetupStatusV1>;
  readonly onStatus: (status: DesktopSetupStatusV1) => void;
  readonly onError: (error: unknown) => void;
  readonly intervalMs?: number;
  readonly wait?: (intervalMs: number, signal: AbortSignal) => Promise<void>;
}

const waitForNextPoll = async (intervalMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });

export const observeSetupStatusUntilTerminal = async ({
  setupId,
  signal,
  readStatus,
  onStatus,
  onError,
  intervalMs = 750,
  wait = waitForNextPoll,
}: SetupStatusPollerOptions): Promise<void> => {
  while (!signal.aborted) {
    try {
      const next = await readStatus(setupId);
      if (signal.aborted) return;
      onStatus(next);
      if (next.state !== "running") return;
      await wait(intervalMs, signal);
    } catch (error) {
      if (!signal.aborted) onError(error);
      return;
    }
  }
};
