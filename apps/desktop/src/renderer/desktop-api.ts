import { DesktopApiError, DesktopErrorV1Schema } from "../shared/ipc.js";

/** Electron copies Error.message across contextBridge but drops custom Error fields. */
export const decodeDesktopError = (reason: unknown): unknown => {
  if (!(reason instanceof Error)) return reason;
  try {
    const envelope: unknown = JSON.parse(reason.message);
    if (typeof envelope !== "object" || envelope === null || !("honeybeeError" in envelope))
      return reason;
    return new DesktopApiError(DesktopErrorV1Schema.parse(envelope.honeybeeError));
  } catch {
    return reason;
  }
};
export const desktopApi = new Proxy({} as typeof window.honeybee, {
  get(_target, property: keyof typeof window.honeybee) {
    const method = window.honeybee[property];
    return (...args: unknown[]) =>
      Promise.resolve(Reflect.apply(method, window.honeybee, args)).catch((reason: unknown) => {
        throw decodeDesktopError(reason);
      });
  },
});
