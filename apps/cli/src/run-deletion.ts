import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { EventIdSchema, RunIdSchema, type RunId } from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError } from "@honeybee/core";
import { z } from "zod";

import {
  readRecoveredImmutableFile,
  UnsafeImmutablePublicationError,
} from "./immutable-publication.js";

const MAX_RECEIPT_BYTES = 64 * 1024;
const TEMP_NAME = /^\.[0-9a-f-]{36}\.tmp$/iu;
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentRunId: RunIdSchema,
    parentTerminalEventId: EventIdSchema,
    childRunIds: z.array(RunIdSchema),
    createdAt: z.string().datetime(),
  })
  .strict();

const MarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentRunId: RunIdSchema,
    runId: RunIdSchema,
    phase: z.enum(["started", "completed"]),
    timestamp: z.string().datetime(),
  })
  .strict();

const ensureDirectory = async (root: string, components: readonly string[]): Promise<string> => {
  let directory = path.resolve(root);
  await mkdir(directory, { recursive: true });
  for (const component of components) {
    const target = path.resolve(directory, component);
    if (path.dirname(target) !== directory) {
      throw new HoneyBeeCoreError("run.invalid-path", "Deletion receipt path escaped its root.");
    }
    try {
      await mkdir(target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new HoneyBeeCoreError("run.indeterminate", "Deletion receipt path contains a link.");
    }
    directory = target;
  }
  return directory;
};

const readReceipt = async (filePath: string): Promise<Buffer> => {
  try {
    return (
      await readRecoveredImmutableFile(
        filePath,
        (candidate) => TEMP_NAME.test(candidate),
        MAX_RECEIPT_BYTES,
      )
    ).bytes;
  } catch (error) {
    if (error instanceof UnsafeImmutablePublicationError) {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Run deletion receipt publication is unsafe.",
      );
    }
    throw error;
  }
};

const publish = async (directory: string, name: string, value: unknown): Promise<void> => {
  const finalPath = path.join(directory, name);
  const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    if (!(await readReceipt(finalPath)).equals(bytes)) {
      throw new HoneyBeeCoreError("run.indeterminate", "Run deletion receipt was overwritten.");
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
};

export class FileRunDeletionTransaction {
  readonly #root: string;

  public constructor(rootDirectory: string) {
    this.#root = path.resolve(rootDirectory);
  }

  async #directory(parentRunId: RunId): Promise<string> {
    return ensureDirectory(this.#root, [".run-deletions", "v1", RunIdSchema.parse(parentRunId)]);
  }

  public async load(
    parentRunIdValue: RunId,
    terminalEventId: string,
    childRunIdsValue: readonly RunId[],
  ): Promise<boolean> {
    const parentRunId = RunIdSchema.parse(parentRunIdValue);
    const childRunIds = childRunIdsValue.map((value) => RunIdSchema.parse(value)).sort();
    const filePath = path.join(await this.#directory(parentRunId), "manifest.json");
    let parsed: z.infer<typeof ManifestSchema>;
    try {
      parsed = ManifestSchema.parse(JSON.parse((await readReceipt(filePath)).toString("utf8")));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("run.indeterminate", "Run deletion manifest is invalid.");
    }
    if (
      parsed.parentRunId !== parentRunId ||
      parsed.parentTerminalEventId !== EventIdSchema.parse(terminalEventId) ||
      JSON.stringify([...parsed.childRunIds].sort()) !== JSON.stringify(childRunIds)
    ) {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Run deletion manifest does not match the terminal batch.",
      );
    }
    return true;
  }

  public async canResumeMissingParent(parentRunIdValue: RunId): Promise<boolean> {
    const parentRunId = RunIdSchema.parse(parentRunIdValue);
    const directory = path.join(this.#root, ".run-deletions", "v1", parentRunId);
    let manifest: z.infer<typeof ManifestSchema>;
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new HoneyBeeCoreError("run.indeterminate", "Run deletion directory is unsafe.");
      }
      manifest = ManifestSchema.parse(
        JSON.parse((await readReceipt(path.join(directory, "manifest.json"))).toString("utf8")),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("run.indeterminate", "Run deletion manifest is invalid.");
    }
    return (
      manifest.parentRunId === parentRunId &&
      (await this.hasMarker(parentRunId, parentRunId, "started"))
    );
  }

  public async create(
    parentRunIdValue: RunId,
    terminalEventId: string,
    childRunIdsValue: readonly RunId[],
  ): Promise<void> {
    const parentRunId = RunIdSchema.parse(parentRunIdValue);
    const directory = await this.#directory(parentRunId);
    await publish(
      directory,
      "manifest.json",
      ManifestSchema.parse({
        schemaVersion: 1,
        parentRunId,
        parentTerminalEventId: EventIdSchema.parse(terminalEventId),
        childRunIds: childRunIdsValue.map((value) => RunIdSchema.parse(value)).sort(),
        createdAt: new Date().toISOString(),
      }),
    );
  }

  public async hasMarker(
    parentRunIdValue: RunId,
    runIdValue: RunId,
    phase: "started" | "completed",
  ): Promise<boolean> {
    const parentRunId = RunIdSchema.parse(parentRunIdValue);
    const runId = RunIdSchema.parse(runIdValue);
    const filePath = path.join(await this.#directory(parentRunId), `${runId}.${phase}.json`);
    try {
      const marker = MarkerSchema.parse(JSON.parse((await readReceipt(filePath)).toString("utf8")));
      if (marker.parentRunId !== parentRunId || marker.runId !== runId || marker.phase !== phase) {
        throw new HoneyBeeCoreError("run.indeterminate", "Run deletion marker is invalid.");
      }
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("run.indeterminate", "Run deletion marker is malformed.");
    }
  }

  public async mark(
    parentRunIdValue: RunId,
    runIdValue: RunId,
    phase: "started" | "completed",
  ): Promise<void> {
    const parentRunId = RunIdSchema.parse(parentRunIdValue);
    const runId = RunIdSchema.parse(runIdValue);
    if (await this.hasMarker(parentRunId, runId, phase)) return;
    await publish(
      await this.#directory(parentRunId),
      `${runId}.${phase}.json`,
      MarkerSchema.parse({
        schemaVersion: 1,
        parentRunId,
        runId,
        phase,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  public async assertPrivateEntries(parentRunIdValue: RunId): Promise<void> {
    const directory = await this.#directory(RunIdSchema.parse(parentRunIdValue));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (TEMP_NAME.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) continue;
      if (
        entry.name === "manifest.json" ||
        /^[0-9a-f-]{36}\.(?:started|completed)\.json$/iu.test(entry.name)
      )
        continue;
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Run deletion receipt directory is corrupt.",
      );
    }
  }
}
