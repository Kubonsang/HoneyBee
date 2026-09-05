import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "./i18n.js";
import { operationError, type OperationError } from "./operation-errors.js";

interface Failure extends OperationError {
  label: MessageKey;
  target: string;
  retry?: () => void;
}
interface Pending {
  id: number;
  scope: string;
  label: MessageKey;
  started: number;
}

/** Captures the operation's scope at dispatch, so late failures stay with their original target. */
export function useOperations(scope: string, target: string) {
  const sequence = useRef(0);
  const latest = useRef(new Map<string, number>());
  const [failures, setFailures] = useState<ReadonlyMap<string, Failure>>(new Map());
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pending.length]);
  const clear = (): void =>
    setFailures((previous) => {
      const next = new Map(previous);
      next.delete(scope);
      return next;
    });
  const reportError = (reason: unknown, targetScope = scope): void => {
    setFailures((previous) => {
      const next = new Map(previous);
      next.set(targetScope, { ...operationError(reason), label: "actions", target });
      return next;
    });
  };
  const run = (operation: () => Promise<void>, label: MessageKey = "actions"): void => {
    const id = ++sequence.current;
    latest.current.set(scope, id);
    clear();
    setPending((previous) => [...previous, { id, scope, label, started: Date.now() }]);
    void Promise.resolve()
      .then(operation)
      .catch((reason: unknown) => {
        if (latest.current.get(scope) !== id) return;
        setFailures((previous) => {
          const next = new Map(previous);
          next.set(scope, {
            ...operationError(reason),
            label,
            target,
            retry: () => run(operation, label),
          });
          return next;
        });
      })
      .finally(() => setPending((previous) => previous.filter((item) => item.id !== id)));
  };
  const current = pending.filter((item) => item.scope === scope);
  return {
    run,
    reportError,
    clear,
    error: failures.get(scope),
    busy: pending.length > 0,
    pending: current.map((item) => ({
      ...item,
      seconds: Math.max(0, Math.floor((now - item.started) / 1000)),
    })),
  };
}
