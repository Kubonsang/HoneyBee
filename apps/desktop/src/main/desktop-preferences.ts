import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { DesktopPreferencesV1Schema, type DesktopPreferencesV1 } from "../shared/ipc.js";

const defaults = (): DesktopPreferencesV1 => ({
  schemaVersion: 1,
  density: "comfortable",
  terminalFontSize: 12,
  fileExplorerWidth: 280,
  workbenchDefault: "files",
  reducedMotion: false,
});

export class DesktopPreferencesStore {
  readonly #directory: string;
  readonly #filePath: string;
  #tail = Promise.resolve();

  public constructor(userDataDirectory: string) {
    this.#directory = path.resolve(userDataDirectory);
    this.#filePath = path.join(this.#directory, "preferences-v1.json");
  }

  public read(): Promise<DesktopPreferencesV1> {
    return this.#serialized(async () => {
      try {
        return DesktopPreferencesV1Schema.parse(JSON.parse(await readFile(this.#filePath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
        throw Object.assign(new Error("Desktop preferences are invalid or unreadable."), {
          code: "desktop.preferences-invalid",
          cause: error,
        });
      }
    });
  }

  public update(value: unknown): Promise<DesktopPreferencesV1> {
    return this.#serialized(async () => {
      const preferences = DesktopPreferencesV1Schema.parse(value);
      await mkdir(this.#directory, { recursive: true });
      const temporary = `${this.#filePath}.${process.pid}-${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(preferences, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, this.#filePath);
      return preferences;
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
