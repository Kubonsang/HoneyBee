import { describe, expect, it } from "vitest";

import { RuntimeOperationError } from "./errors.js";
import { JsonlDecoder } from "./jsonl.js";

describe("JsonlDecoder", () => {
  it("handles split UTF-8 chunks and coalesced CRLF/LF frames", () => {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from('{"text":"한글"}\r\n{"n":2}\n', "utf8");
    const splitInsideUnicode = bytes.indexOf(Buffer.from("한", "utf8")) + 1;

    expect(decoder.push(bytes.subarray(0, splitInsideUnicode))).toEqual([]);
    expect(decoder.push(bytes.subarray(splitInsideUnicode))).toEqual([
      '{"text":"한글"}',
      '{"n":2}',
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("ignores blank lines and enforces line/buffer limits", () => {
    const decoder = new JsonlDecoder({ maxLineBytes: 8, maxBufferBytes: 10 });

    expect(decoder.push("\n\r\n{}\n")).toEqual(["{}"]);
    expect(() => decoder.push("12345678901")).toThrowError(RuntimeOperationError);
  });

  it("rejects incomplete frames at EOF and pushes after EOF", () => {
    const decoder = new JsonlDecoder();
    decoder.push('{"partial":true}');

    expect(() => decoder.finish()).toThrowError(RuntimeOperationError);
    expect(() => decoder.push("\n")).toThrowError(RuntimeOperationError);
  });
});
