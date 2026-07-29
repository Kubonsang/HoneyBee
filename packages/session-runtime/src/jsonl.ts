import { StringDecoder } from "node:string_decoder";

import { RuntimeOperationError } from "./errors.js";

export interface JsonlDecoderOptions {
  readonly maxLineBytes?: number;
  readonly maxBufferBytes?: number;
}

export class JsonlDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineBytes: number;
  readonly #maxBufferBytes: number;
  #buffer = "";
  #ended = false;

  public constructor(options: JsonlDecoderOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#maxBufferBytes = options.maxBufferBytes ?? this.#maxLineBytes * 2;
    if (
      !Number.isSafeInteger(this.#maxLineBytes) ||
      !Number.isSafeInteger(this.#maxBufferBytes) ||
      this.#maxLineBytes <= 0 ||
      this.#maxBufferBytes < this.#maxLineBytes
    ) {
      throw new RangeError("JSONL byte limits are invalid.");
    }
  }

  public push(chunk: Buffer | string): readonly string[] {
    if (this.#ended) {
      throw new RuntimeOperationError(
        "protocol.invalid-message",
        "Cannot push JSONL data after EOF.",
        false,
      );
    }
    this.#buffer +=
      typeof chunk === "string"
        ? this.#decoder.write(Buffer.from(chunk, "utf8"))
        : this.#decoder.write(chunk);
    return this.#drain();
  }

  public finish(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#buffer += this.#decoder.end();
    const lines = this.#drain();
    if (lines.length > 0 || this.#buffer.length > 0) {
      throw new RuntimeOperationError(
        "protocol.invalid-message",
        "JSONL stream ended with an incomplete frame.",
        false,
      );
    }
  }

  #drain(): readonly string[] {
    const lines: string[] = [];
    let lineEnd = this.#buffer.indexOf("\n");
    while (lineEnd >= 0) {
      let line = this.#buffer.slice(0, lineEnd);
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
        throw new RuntimeOperationError(
          "protocol.line-limit",
          "JSONL frame exceeded the maximum line size.",
          false,
        );
      }
      if (line.trim().length > 0) {
        lines.push(line);
      }
      lineEnd = this.#buffer.indexOf("\n");
    }

    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxBufferBytes) {
      throw new RuntimeOperationError(
        "protocol.line-limit",
        "JSONL receive buffer exceeded its maximum size.",
        false,
      );
    }
    return lines;
  }
}
