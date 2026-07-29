import { describe, expect, it } from "vitest";

import { TextRingBuffer } from "./ring-buffer.js";

describe("TextRingBuffer", () => {
  it("bounds UTF-8 bytes without splitting Unicode code points", () => {
    const buffer = new TextRingBuffer(6);

    buffer.append("ab한글");

    expect(buffer.byteLength).toBeLessThanOrEqual(8);
    expect(buffer.snapshot()).toBe("한글");
    expect(buffer.truncatedBytes).toBe(2);
    expect(buffer.snapshot()).not.toContain("�");
  });

  it("preserves ANSI/control strings exactly while retaining the newest data", () => {
    const buffer = new TextRingBuffer(12);
    const ansi = "\u001b[31mred\u001b[0m";

    buffer.append("old");
    buffer.append(ansi);

    expect(buffer.snapshot()).toBe(ansi);
    expect(buffer.byteLength).toBe(Buffer.byteLength(ansi));
    expect(buffer.truncatedBytes).toBe(3);
  });
});
