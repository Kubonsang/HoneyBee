import type { HoneyBeeDesktopApi } from "../shared/ipc.js";

declare global {
  interface Window {
    readonly honeybee: HoneyBeeDesktopApi;
  }
}

export {};
