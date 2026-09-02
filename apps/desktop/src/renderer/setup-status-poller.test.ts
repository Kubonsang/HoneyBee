import { describe, expect, it, vi } from "vitest";

import type { DesktopSetupStatusV1 } from "../shared/ipc.js";
import { observeSetupStatusUntilTerminal } from "./setup-status-poller.js";

const setupId = "11111111-1111-4111-8111-111111111111";
const status = (state: DesktopSetupStatusV1["state"], phase: string): DesktopSetupStatusV1 => ({
  schemaVersion: 1,
  setupId,
  state,
  phase,
  message: phase,
});

describe("observeSetupStatusUntilTerminal", () => {
  it("observes an immediately completed setup after the initial running response", async () => {
    const readStatus = vi
      .fn<(setupId: string) => Promise<DesktopSetupStatusV1>>()
      .mockResolvedValueOnce(status("running", "setup.started"))
      .mockResolvedValueOnce(status("completed", "setup.completed"));
    const onStatus = vi.fn();
    const onError = vi.fn();

    await observeSetupStatusUntilTerminal({
      setupId,
      signal: new AbortController().signal,
      readStatus,
      onStatus,
      onError,
      wait: async () => undefined,
    });

    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(onStatus.mock.calls.map(([next]) => next.phase)).toEqual([
      "setup.started",
      "setup.completed",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops without another read when the owning view is aborted", async () => {
    const aborter = new AbortController();
    const readStatus = vi.fn(async () => status("running", "setup.started"));

    await observeSetupStatusUntilTerminal({
      setupId,
      signal: aborter.signal,
      readStatus,
      onStatus: vi.fn(),
      onError: vi.fn(),
      wait: async () => {
        aborter.abort();
      },
    });

    expect(readStatus).toHaveBeenCalledTimes(1);
  });
});
