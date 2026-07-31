import {
  SessionRunRecordSchema,
  transitionSessionRun,
  type SessionRunRecord,
} from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import {
  GlobalStateSessionRunRepository,
  SESSION_RUN_STORAGE_KEY,
} from "./global-state-session-run-repository.js";
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
    if (this.#release === undefined) throw new Error("No Session Run write is waiting.");
    this.#release();
  }
}

const starting = (runId: string, overrides: Partial<SessionRunRecord> = {}): SessionRunRecord =>
  SessionRunRecordSchema.parse({
    runId,
    sessionId: `session-${runId}`,
    runtimeInstanceId: "runtime-1",
    phase: "starting",
    startedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  });

const running = (run: SessionRunRecord): SessionRunRecord => {
  const result = transitionSessionRun(run, {
    phase: "running",
    updatedAt: "2026-07-30T10:01:00.000Z",
  });
  if (!result.ok) throw result.error;
  return result.value;
};

describe("GlobalStateSessionRunRepository", () => {
  it("round-trips across recreation and enforces monotonic identity", async () => {
    const state = new MemoryMemento();
    const first = new GlobalStateSessionRunRepository(state);
    const initial = starting("run-1");
    await first.save(initial);
    await first.save(running(initial));
    const reverse = await first.save(initial);
    const restarted = new GlobalStateSessionRunRepository(state);
    const restored = await restarted.getByRunId(initial.runId);
    expect(restored.ok ? restored.value?.phase : undefined).toBe("running");
    expect(reverse.ok ? undefined : reverse.error.code).toBe("conflict");
  });

  it("serializes concurrent saves and flush waits for the write tail", async () => {
    const state = new SlowMemento();
    const repository = new GlobalStateSessionRunRepository(state);
    await Promise.all([repository.save(starting("a")), repository.save(starting("b"))]);
    const listed = await repository.list();
    expect(listed.ok ? listed.value.map(({ runId }) => runId) : []).toEqual(["a", "b"]);

    const gated = new GatedMemento();
    const gatedRepository = new GlobalStateSessionRunRepository(gated);
    const saving = gatedRepository.save(starting("c"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let flushed = false;
    const flushing = gatedRepository.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    gated.release();
    await Promise.all([saving, flushing]);
    expect(flushed).toBe(true);
  });

  it("preserves invalid persisted data without overwriting it", async () => {
    const state = new MemoryMemento();
    const invalid = [{ ...starting("run-1"), prompt: "forbidden" }];
    await state.update(SESSION_RUN_STORAGE_KEY, invalid);
    const repository = new GlobalStateSessionRunRepository(state);
    const listed = await repository.list();
    const saved = await repository.save(starting("run-2"));
    expect(listed.ok ? undefined : listed.error.code).toBe("validation");
    expect(saved.ok ? undefined : saved.error.code).toBe("validation");
    expect(state.get(SESSION_RUN_STORAGE_KEY, [])).toEqual(invalid);
  });

  it("rejects persisted stores with two active Runs for one Session", async () => {
    const state = new MemoryMemento();
    const sessionId = starting("shared").sessionId;
    const invalid = [starting("run-1", { sessionId }), starting("run-2", { sessionId })];
    await state.update(SESSION_RUN_STORAGE_KEY, invalid);
    const repository = new GlobalStateSessionRunRepository(state);
    const listed = await repository.listActive();
    const saved = await repository.save(starting("run-3"));
    expect(listed.ok ? undefined : listed.error.code).toBe("validation");
    expect(saved.ok ? undefined : saved.error.code).toBe("validation");
    expect(state.get(SESSION_RUN_STORAGE_KEY, [])).toEqual(invalid);
  });

  it("lists only Runs owned by one Session after recreation", async () => {
    const state = new MemoryMemento();
    const repository = new GlobalStateSessionRunRepository(state);
    const sessionId = starting("run-1").sessionId;
    await repository.save(starting("run-1"));
    await repository.save(
      starting("run-2", {
        sessionId: "other-session" as SessionRunRecord["sessionId"],
      }),
    );
    await repository.flush();
    const restarted = new GlobalStateSessionRunRepository(state);
    const listed = await restarted.listBySessionId(sessionId);
    expect(listed.ok ? listed.value.map(({ runId }) => runId) : []).toEqual(["run-1"]);
  });
});
