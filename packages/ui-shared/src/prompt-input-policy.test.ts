import { describe, expect, it } from "vitest";

import { createPromptKeyBindings, shouldSubmitPrompt } from "./prompt-input-policy.js";

describe("Prompt input policy", () => {
  it("keeps Enter and Ctrl+Enter for submit and Alt+Enter and Shift+Enter for newline", () => {
    const enter = 3;
    const control = 1 << 11;
    const shift = 1 << 10;
    const alt = 1 << 9;

    expect(createPromptKeyBindings(enter, control, shift, alt)).toEqual({
      submit: [enter, control | enter],
      newline: [shift | enter, alt | enter],
    });
  });

  it("blocks empty, composing, and pending submissions", () => {
    expect(shouldSubmitPrompt("", false, false)).toBe(false);
    expect(shouldSubmitPrompt("  \n", false, false)).toBe(false);
    expect(shouldSubmitPrompt("?? ??", true, false)).toBe(false);
    expect(shouldSubmitPrompt("send once", false, true)).toBe(false);
    expect(shouldSubmitPrompt("send once", false, false)).toBe(true);
  });
});
