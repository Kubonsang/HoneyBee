import { describe, expect, it } from "vitest";

import { fingerprintPromptContent } from "./prompt-content-fingerprint.js";

describe("fingerprintPromptContent", () => {
  it("returns the same digest for the same exact Prompt", () => {
    expect(fingerprintPromptContent("?? Prompt\r\nline")).toEqual(
      fingerprintPromptContent("?? Prompt\r\nline"),
    );
  });

  it.each([
    ["line\n", "line\r\n"],
    [" leading", "leading"],
    ["?", "e\u0301"],
    ["??", "?? "],
  ])("distinguishes exact content %j from %j", (left, right) => {
    expect(fingerprintPromptContent(left)).not.toEqual(fingerprintPromptContent(right));
  });

  it("stores a UTF-8 byte length and never includes the Prompt source", () => {
    const source = "?? Prompt";
    const fingerprint = fingerprintPromptContent(source);

    expect(fingerprint.contentLength).toBe(Buffer.byteLength(source, "utf8"));
    expect(JSON.stringify(fingerprint)).not.toContain(source);
    expect(fingerprint.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
