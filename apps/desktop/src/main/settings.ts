import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DesktopProjectProfileSchema, type DesktopProjectProfile } from "../shared/ipc.js";

const DesktopSettingsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
  })
  .strict();

const DesktopSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(DesktopProjectProfileSchema).max(50),
  })
  .strict();

const emptySettings = () => DesktopSettingsV2Schema.parse({ schemaVersion: 2, profiles: [] });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export class DesktopSettingsStore {
  readonly #directory: string;
  readonly #filePath: string;

  public constructor(userDataDirectory: string) {
    this.#directory = path.resolve(userDataDirectory);
    this.#filePath = path.join(this.#directory, "settings-v2.json");
  }

  public async listProfiles(): Promise<readonly DesktopProjectProfile[]> {
    const settings = await this.#read();
    return [...settings.profiles].sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt),
    );
  }

  public async upsertProfile(profileValue: DesktopProjectProfile): Promise<void> {
    const profile = DesktopProjectProfileSchema.parse(profileValue);
    const settings = await this.#read();
    const profiles = settings.profiles.filter(
      (candidate) =>
        candidate.profileId !== profile.profileId &&
        !(
          candidate.projectPath === profile.projectPath &&
          candidate.batchConfigPath === profile.batchConfigPath
        ),
    );
    await this.#write({ schemaVersion: 2, profiles: [profile, ...profiles].slice(0, 50) });
  }

  public async removeProfile(profileId: string): Promise<void> {
    const settings = await this.#read();
    await this.#write({
      schemaVersion: 2,
      profiles: settings.profiles.filter((profile) => profile.profileId !== profileId),
    });
  }

  async #read(): Promise<z.infer<typeof DesktopSettingsV2Schema>> {
    try {
      const entry = await lstat(this.#filePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) {
        throw new Error("invalid settings file");
      }
      return DesktopSettingsV2Schema.parse(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        try {
          const legacyPath = path.join(this.#directory, "settings-v1.json");
          const legacy = DesktopSettingsV1Schema.parse(
            JSON.parse(await readFile(legacyPath, "utf8")),
          );
          return DesktopSettingsV2Schema.parse({ schemaVersion: 2, profiles: legacy.profiles });
        } catch (legacyError) {
          if (errorCode(legacyError) === "ENOENT") return emptySettings();
          throw new Error("Desktop settings are invalid or unreadable.", { cause: legacyError });
        }
      }
      throw new Error("Desktop settings are invalid or unreadable.", { cause: error });
    }
  }

  async #write(value: unknown): Promise<void> {
    const settings = DesktopSettingsV2Schema.parse(value);
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
