import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionIdSchema, type SessionId } from "@honeybee/domain";
import type { PromptSendMessage } from "@honeybee/ui-shared";

import type { PromptDeliveryResult } from "../application/prompt-delivery.js";
import {
  PromptDeliveryCoordinator,
  type PromptDeliveryServicePort,
} from "./prompt-delivery-coordinator.js";

class FakePromptService implements PromptDeliveryServicePort {
  readonly drafts: { readonly sessionId: SessionId; readonly content: string }[] = [];
  readonly deliveries: { readonly sessionId: SessionId; readonly content: string }[] = [];
  saveDraftImplementation: (() => Promise<void>) | undefined;
  sendPromptImplementation: (() => Promise<PromptDeliveryResult>) | undefined;

  public async saveDraft(sessionId: SessionId, content: string): Promise<void> {
    this.drafts.push({ sessionId, content });
    await this.saveDraftImplementation?.();
  }

  public async sendPrompt(sessionId: SessionId, content: string): Promise<PromptDeliveryResult> {
    this.deliveries.push({ sessionId, content });
    return (
      (await this.sendPromptImplementation?.()) ?? {
        status: "accepted",
        draftCleanup: "cleared",
      }
    );
  }
}

const request = (
  requestId = "request-1",
  sessionId = "session-1",
  content = "Prompt content",
): PromptSendMessage & { readonly sessionId: SessionId } => ({
  type: "prompt.send",
  requestId,
  sessionId: SessionIdSchema.parse(sessionId),
  content,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PromptDeliveryCoordinator", () => {
  it("returns a correlated accepted acknowledgement", async () => {
    const service = new FakePromptService();
    const coordinator = new PromptDeliveryCoordinator(service, vi.fn(), vi.fn());

    await expect(coordinator.deliver(request())).resolves.toEqual({
      type: "prompt.accepted",
      requestId: "request-1",
      sessionId: "session-1",
      draftCleanup: "cleared",
    });
    expect(service.deliveries).toEqual([
      { sessionId: SessionIdSchema.parse("session-1"), content: "Prompt content" },
    ]);
  });

  it("returns a correlated rejected acknowledgement", async () => {
    const service = new FakePromptService();
    service.sendPromptImplementation = async () => ({
      status: "rejected",
      message: "Runtime input failed.",
    });
    const diagnostics: string[] = [];
    const coordinator = new PromptDeliveryCoordinator(service, vi.fn(), (message) => {
      diagnostics.push(message);
    });

    await expect(coordinator.deliver(request())).resolves.toEqual({
      type: "prompt.rejected",
      requestId: "request-1",
      sessionId: "session-1",
      message: "Runtime input failed.",
    });
    expect(diagnostics.join("\n")).toContain("request-1");
    expect(diagnostics.join("\n")).not.toContain("Prompt content");
  });

  it("cancels a pending debounce before immediate delivery and blocks its stale write", async () => {
    vi.useFakeTimers();
    const service = new FakePromptService();
    const coordinator = new PromptDeliveryCoordinator(service, vi.fn(), vi.fn());
    const sessionId = SessionIdSchema.parse("session-1");

    coordinator.scheduleDraft(sessionId, "debounced content");
    await coordinator.deliver(request("request-1", "session-1", "submitted content"));
    await vi.runAllTimersAsync();

    expect(service.drafts).toEqual([]);
    expect(service.deliveries).toEqual([{ sessionId, content: "submitted content" }]);
  });

  it("drains an in-flight Draft write before delivering the exact Prompt", async () => {
    vi.useFakeTimers();
    const service = new FakePromptService();
    let releaseSave: (() => void) | undefined;
    service.saveDraftImplementation = () =>
      new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    const coordinator = new PromptDeliveryCoordinator(service, vi.fn(), vi.fn());
    const sessionId = SessionIdSchema.parse("session-1");

    coordinator.scheduleDraft(sessionId, "older Draft");
    await vi.advanceTimersByTimeAsync(250);
    const delivery = coordinator.deliver(request("request-1", "session-1", "submitted content"));
    await Promise.resolve();
    expect(service.deliveries).toEqual([]);

    releaseSave?.();
    await delivery;
    expect(service.drafts).toEqual([{ sessionId, content: "older Draft" }]);
    expect(service.deliveries).toEqual([{ sessionId, content: "submitted content" }]);
  });

  it("ignores a duplicate request ID without delivering twice", async () => {
    const service = new FakePromptService();
    const coordinator = new PromptDeliveryCoordinator(service, vi.fn(), vi.fn());
    const submitted = request();

    await expect(coordinator.deliver(submitted)).resolves.toMatchObject({
      type: "prompt.accepted",
    });
    await expect(coordinator.deliver(submitted)).resolves.toBeUndefined();
    expect(service.deliveries).toHaveLength(1);
  });

  it("rejects a second request while the Session delivery is pending", async () => {
    const service = new FakePromptService();
    let releaseDelivery: (() => void) | undefined;
    service.sendPromptImplementation = () =>
      new Promise<PromptDeliveryResult>((resolve) => {
        releaseDelivery = () => {
          resolve({ status: "accepted", draftCleanup: "cleared" });
        };
      });
    const coordinator = new PromptDeliveryCoordinator(service, vi.fn(), vi.fn());

    const first = coordinator.deliver(request("request-1"));
    await vi.waitFor(() => expect(service.deliveries).toHaveLength(1));
    await expect(coordinator.deliver(request("request-2"))).resolves.toEqual({
      type: "prompt.rejected",
      requestId: "request-2",
      sessionId: "session-1",
      message: "Another Prompt is already being delivered for this Session.",
    });

    releaseDelivery?.();
    await first;
    expect(service.deliveries).toHaveLength(1);
  });
});
