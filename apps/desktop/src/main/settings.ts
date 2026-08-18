import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DesktopProjectProfileV1Schema, type DesktopProjectProfileV1 } from "../shared/ipc.js";

const DesktopSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(DesktopProjectProfileV1Schema).max(50),
  })
  .strict();

const emptySettings = () => DesktopSettingsV1Schema.parse({ schemaVersion: 1, profiles: [] });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export class DesktopSettingsStore {
  readonly #directory: string;
  readonly #filePath: string;

  public constructor(userDataDirectory: string) {
    this.#directory = path.resolve(userDataDirectory);
    this.#filePath = path.join(this.#directory, "settings-v1.json");
  }

  public async listProfiles(): Promise<readonly DesktopProjectProfileV1[]> {
    const settings = await this.#read();
    return [...settings.profiles].sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt),
    );
  }

  public async upsertProfile(profileValue: DesktopProjectProfileV1): Promise<void> {
    const profile = DesktopProjectProfileV1Schema.parse(profileValue);
    const settings = await this.#read();
    const profiles = settings.profiles.filter(
      (candidate) =>
        candidate.profileId !== profile.profileId &&
        !(
          candidate.projectPath === profile.projectPath &&
          candidate.batchConfigPath === profile.batchConfigPath
        ),
    );
    await this.#write({ schemaVersion: 1, profiles: [profile, ...profiles].slice(0, 50) });
  }

  public async removeProfile(profileId: string): Promise<void> {
    const settings = await this.#read();
    await this.#write({
      schemaVersion: 1,
      profiles: settings.profiles.filter((profile) => profile.profileId !== profileId),
    });
  }

  async #read(): Promise<z.infer<typeof DesktopSettingsV1Schema>> {
    try {
      const entry = await lstat(this.#filePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) {
        throw new Error("invalid settings file");
      }
      return DesktopSettingsV1Schema.parse(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptySettings();
      throw new Error("Desktop settings are invalid or unreadable.", { cause: error });
    }
  }

  async #write(value: unknown): Promise<void> {
    const settings = DesktopSettingsV1Schema.parse(value);
    await mkdir(this.#directory, { recursive: true });
    const directory = await lstat(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("Desktop settings directory is unsafe.");
    }
    const temporaryPath = path.join(this.#directory, `.settings-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(Buffer.from(JSON.stringify(settings), "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
