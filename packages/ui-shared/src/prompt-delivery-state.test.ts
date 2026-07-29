import { describe, expect, it } from "vitest";

import type { PromptSendMessage } from "./contracts.js";
import { PromptDeliveryTracker, reconcileDraftAfterSettlement } from "./prompt-delivery-state.js";

const prompt = (
  requestId = "request-1",
  sessionId = "session-1",
  content = "keep this Prompt",
): PromptSendMessage => ({
  type: "prompt.send",
  requestId,
  sessionId,
  content,
});

describe("PromptDeliveryTracker", () => {
  it("keeps editor content until a matching accepted acknowledgement", () => {
    const tracker = new PromptDeliveryTracker();
    const submitted = prompt();

    expect(tracker.begin(submitted)).toBe(true);
    expect(reconcileDraftAfterSettlement(submitted.content, { status: "ignored" })).toBe(
      submitted.content,
    );

    const accepted = tracker.settle({
      type: "prompt.accepted",
      requestId: submitted.requestId,
      sessionId: submitted.sessionId,
      draftCleanup: "cleared",
    });
    expect(reconcileDraftAfterSettlement(submitted.content, accepted)).toBe("");
  });

  it("keeps editor content after rejection", () => {
    const tracker = new PromptDeliveryTracker();
    const submitted = prompt();
    tracker.begin(submitted);

    const rejected = tracker.settle({
      type: "prompt.rejected",
      requestId: submitted.requestId,
      sessionId: submitted.sessionId,
      message: "Runtime write failed.",
    });

    expect(rejected.status).toBe("rejected");
    expect(reconcileDraftAfterSettlement(submitted.content, rejected)).toBe(submitted.content);
  });

  it("blocks a duplicate submit while one Prompt is pending", () => {
    const tracker = new PromptDeliveryTracker();
    expect(tracker.begin(prompt())).toBe(true);
    expect(tracker.begin(prompt("request-2"))).toBe(false);
    expect(tracker.isPending("session-1")).toBe(true);
  });

  it("does not let another Session acknowledgement clear the current Draft", () => {
    const tracker = new PromptDeliveryTracker();
    tracker.begin(prompt());

    const otherSession = tracker.settle({
      type: "prompt.accepted",
      requestId: "request-1",
      sessionId: "session-2",
      draftCleanup: "cleared",
    });

    expect(otherSession).toEqual({ status: "ignored" });
    expect(reconcileDraftAfterSettlement("new Session Draft", otherSession)).toBe(
      "new Session Draft",
    );
    expect(tracker.isPending("session-1")).toBe(true);
  });

  it("ignores stale and duplicate acknowledgements", () => {
    const tracker = new PromptDeliveryTracker();
    tracker.begin(prompt("current-request"));

    expect(
      tracker.settle({
        type: "prompt.accepted",
        requestId: "old-request",
        sessionId: "session-1",
        draftCleanup: "cleared",
      }),
    ).toEqual({ status: "ignored" });

    const accepted = tracker.settle({
      type: "prompt.accepted",
      requestId: "current-request",
      sessionId: "session-1",
      draftCleanup: "cleared",
    });
    expect(accepted.status).toBe("accepted");
    expect(
      tracker.settle({
        type: "prompt.accepted",
        requestId: "current-request",
        sessionId: "session-1",
        draftCleanup: "cleared",
      }),
    ).toEqual({ status: "ignored" });
  });

  it("preserves text written after submission when an older success arrives", () => {
    const tracker = new PromptDeliveryTracker();
    tracker.begin(prompt("request-1", "session-1", "submitted"));
    const accepted = tracker.settle({
      type: "prompt.accepted",
      requestId: "request-1",
      sessionId: "session-1",
      draftCleanup: "cleared",
    });

    expect(reconcileDraftAfterSettlement("new content", accepted)).toBe("new content");
  });
});
