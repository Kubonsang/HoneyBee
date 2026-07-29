import type { SessionId } from "@honeybee/domain";

export class SessionSelectionService {
  readonly #listeners = new Set<(sessionId: SessionId | undefined) => void>();
  #selectedSessionId: SessionId | undefined;

  public constructor(selectedSessionId?: SessionId) {
    this.#selectedSessionId = selectedSessionId;
  }

  public get selectedSessionId(): SessionId | undefined {
    return this.#selectedSessionId;
  }

  public select(sessionId: SessionId | undefined): void {
    if (this.#selectedSessionId === sessionId) {
      return;
    }
    this.#selectedSessionId = sessionId;
    for (const listener of this.#listeners) {
      listener(sessionId);
    }
  }

  public onDidSelect(listener: (sessionId: SessionId | undefined) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
}
