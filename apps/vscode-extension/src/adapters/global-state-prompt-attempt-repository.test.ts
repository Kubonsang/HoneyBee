import {
  PromptDeliveryAttemptSchema,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
} from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import {
  GlobalStatePromptDeliveryAttemptRepository,
  PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY,
} from "./global-state-prompt-attempt-repository.js";
import type { MementoPort } from "./global-state-repositories.js";

class MemoryMemento implements MementoPort {
  readonly #values = new Map<string, unknown>();
  public get<T>(key: string, defaultValue: T): T {
    return (this.#values.has(key) ? structuredClone(this.#values.get(key)) : defaultValue) as T;
  }
  public update(key: string, value: unknown): Thenable<void> {
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}
class SlowMemento extends MemoryMemento {
  public override async update(key: string, value: unknown): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await super.update(key, value);
  }
}
class GatedMemento extends MemoryMemento {
  #release: (() => void) | undefined;
  public override update(key: string, value: unknown): Thenable<void> {
    return new Promise<void>((resolve) => {
      this.#release = () => void Promise.resolve(super.update(key, value)).then(resolve);
    });
  }
  public release(): void {
    if (this.#release === undefined) throw new Error("No Attempt write is waiting.");
    this.#release();
  }
}

const prepared = (
  requestId: string,
  overrides: Partial<PromptDeliveryAttempt> = {},
): PromptDeliveryAttempt =>
  PromptDeliveryAttemptSchema.parse({
    requestId,
    sessionId: "session-1",
    contentDigest: `sha256:${requestId.padEnd(64, "a")}`,
    contentLength: requestId.length,
    phase: "prepared",
    preparedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  });
const move = (
  attempt: PromptDeliveryAttempt,
  change: Parameters<typeof transitionPromptDeliveryAttempt>[1],
): PromptDeliveryAttempt => {
  const result = transitionPromptDeliveryAttempt(attempt, change);
  if (!result.ok) throw result.error;
  return result.value;
};

describe("GlobalStatePromptDeliveryAttemptRepository", () => {
  it("round-trips across repository recreation and enforces monotonic identity", async () => {
    const state = new MemoryMemento();
    const first = new GlobalStatePromptDeliveryAttemptRepository(state);
    const initial = prepared("a");
    const dispatching = move(initial, {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    await first.save(initial);
    await first.save(dispatching);
    const identityConflict = await first.save({ ...dispatching, contentLength: 42 });
    const reverse = await first.save(initial);

    const restarted = new GlobalStatePromptDeliveryAttemptRepository(state);
    const restored = await restarted.getByRequestId("a");
    expect(restored.ok ? restored.value?.phase : undefined).toBe("dispatching");
    expect(identityConflict.ok ? undefined : identityConflict.error.code).toBe("conflict");
    expect(reverse.ok ? undefined : reverse.error.code).toBe("conflict");
  });

  it("rejects invalid persisted data without overwriting it", async () => {
    const state = new MemoryMemento();
    const invalid = [{ ...prepared("a"), contentDigest: "invalid" }];
    await state.update(PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY, invalid);
    const repository = new GlobalStatePromptDeliveryAttemptRepository(state);

    const listed = await repository.list();
    const saved = await repository.save(prepared("b"));

    expect(listed.ok ? undefined : listed.error.code).toBe("validation");
    expect(saved.ok ? undefined : saved.error.code).toBe("validation");
    expect(state.get(PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY, [])).toEqual(invalid);
  });

  it("serializes concurrent saves so neither identity is lost", async () => {
    const state = new SlowMemento();
    const repository = new GlobalStatePromptDeliveryAttemptRepository(state);
    await Promise.all([repository.save(prepared("a")), repository.save(prepared("b"))]);
    const listed = await repository.list();
    expect(listed.ok ? listed.value.map(({ requestId }) => requestId) : []).toEqual(["a", "b"]);
  });

  it("prunes terminal Attempts while preserving active unknown", async () => {
    const state = new MemoryMemento();
    const repository = new GlobalStatePromptDeliveryAttemptRepository(state);
    const terminalA = move(prepared("a"), {
      phase: "cancelled-before-dispatch",
      updatedAt: "2026-07-30T10:01:00.000Z",
      resolvedAt: "2026-07-30T10:01:00.000Z",
    });
    const terminalB = move(
      prepared("b", {
        preparedAt: "2026-07-30T11:00:00.000Z",
        updatedAt: "2026-07-30T11:00:00.000Z",
      }),
      {
        phase: "cancelled-before-dispatch",
        updatedAt: "2026-07-30T11:01:00.000Z",
        resolvedAt: "2026-07-30T11:01:00.000Z",
      },
    );
    const dispatching = move(prepared("c"), {
      phase: "dispatching",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
    const unknown = move(dispatching, {
      phase: "unknown",
      updatedAt: "2026-07-30T12:01:00.000Z",
    });
    const acceptedDispatching = move(
      prepared("d", {
        preparedAt: "2026-07-30T13:00:00.000Z",
        updatedAt: "2026-07-30T13:00:00.000Z",
      }),
      { phase: "dispatching", updatedAt: "2026-07-30T13:01:00.000Z" },
    );
    const runtimeAccepted = move(acceptedDispatching, {
      phase: "runtime-accepted",
      updatedAt: "2026-07-30T13:02:00.000Z",
      acceptedAt: "2026-07-30T13:02:00.000Z",
    });
    await Promise.all([
      repository.save(terminalA),
      repository.save(terminalB),
      repository.save(unknown),
      repository.save(runtimeAccepted),
    ]);

    const pruned = await repository.prune({ maxTerminalAttempts: 1 });
    const listed = await repository.list();
    expect(pruned.ok ? pruned.value : undefined).toBe(1);
    expect(listed.ok ? listed.value.map(({ requestId }) => requestId) : []).toEqual([
      "c",
      "b",
      "d",
    ]);
    expect(JSON.stringify(listed)).not.toContain("Prompt body");
  });

  it("waits for the serialized write tail when flushed", async () => {
    const state = new GatedMemento();
    const repository = new GlobalStatePromptDeliveryAttemptRepository(state);
    const saving = repository.save(prepared("a"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let flushed = false;
    const flushing = repository.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    state.release();
    await Promise.all([saving, flushing]);
    expect(flushed).toBe(true);
  });
});
