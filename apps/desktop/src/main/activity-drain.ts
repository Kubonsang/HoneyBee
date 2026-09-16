/** Keeps accepted IPC operations alive while a quit request closes admission. */
export class DesktopActivityDrain {
  #pending = 0;
  #closing = false;
  readonly #onDrained: () => void;
  constructor(onDrained: () => void) {
    this.#onDrained = onDrained;
  }
  get isClosing(): boolean {
    return this.#closing;
  }
  requestQuit(): boolean {
    this.#closing = true;
    return this.#pending === 0;
  }
  cancelQuit(): void {
    this.#closing = false;
  }
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#closing) throw new Error("HoneyBee is closing. Wait for current work to finish.");
    this.#pending++;
    try {
      return await operation();
    } finally {
      this.#pending--;
      if (this.#closing && this.#pending === 0) this.#onDrained();
    }
  }
}
