export class TextRingBuffer {
  readonly #chunks: string[] = [];
  #byteLength = 0;
  #truncatedBytes = 0;

  public constructor(public readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("Ring buffer maxBytes must be a positive safe integer.");
    }
  }

  public get byteLength(): number {
    return this.#byteLength;
  }

  public get truncatedBytes(): number {
    return this.#truncatedBytes;
  }

  public append(data: string): void {
    if (data.length === 0) {
      return;
    }
    this.#chunks.push(data);
    this.#byteLength += Buffer.byteLength(data, "utf8");
    this.#trim();
  }

  public snapshot(): string {
    return this.#chunks.join("");
  }

  #trim(): void {
    while (this.#byteLength > this.maxBytes && this.#chunks.length > 0) {
      const first = this.#chunks[0];
      if (first === undefined) {
        return;
      }
      const firstBytes = Buffer.byteLength(first, "utf8");
      const overflow = this.#byteLength - this.maxBytes;
      if (firstBytes <= overflow) {
        this.#chunks.shift();
        this.#byteLength -= firstBytes;
        this.#truncatedBytes += firstBytes;
        continue;
      }

      const characters = Array.from(first);
      let removedBytes = 0;
      let removeCount = 0;
      while (removeCount < characters.length && removedBytes < overflow) {
        const character = characters[removeCount];
        if (character === undefined) {
          break;
        }
        removedBytes += Buffer.byteLength(character, "utf8");
        removeCount += 1;
      }
      const remainder = characters.slice(removeCount).join("");
      this.#chunks[0] = remainder;
      this.#byteLength -= removedBytes;
      this.#truncatedBytes += removedBytes;
    }
  }
}
