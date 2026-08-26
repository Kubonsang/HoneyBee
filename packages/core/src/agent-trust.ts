import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  AgentLaunchTrustV1Schema,
  type AgentCommand,
  type AgentLaunchTrustFileV1,
  type AgentLaunchTrustV1,
} from "@honeybee/orchestration-contracts";

import { HoneyBeeCoreError } from "./errors.js";

export interface AgentTrustPath {
  readonly role: AgentLaunchTrustFileV1["role"];
  readonly path: string;
}

const pathKey = (value: string): string =>
  process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);

const inspectFile = async (candidate: AgentTrustPath): Promise<AgentLaunchTrustFileV1> => {
  if (!path.isAbsolute(candidate.path)) {
    throw new HoneyBeeCoreError("agent.trust-invalid", "Agent trust paths must be absolute.");
  }
  const lexical = await lstat(candidate.path).catch(() => undefined);
  if (lexical === undefined || !lexical.isFile() || lexical.isSymbolicLink()) {
    throw new HoneyBeeCoreError(
      "agent.trust-invalid",
      "Agent trust paths must identify regular files without links.",
    );
  }
  const resolved = path.resolve(await realpath(candidate.path));
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new HoneyBeeCoreError("agent.trust-invalid", "Agent launch content is not a file.");
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(resolved);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return {
    role: candidate.role,
    path: resolved,
    byteLength: metadata.size,
    sha256: hash.digest("hex"),
  };
};

const trustDigest = (files: readonly AgentLaunchTrustFileV1[]): string =>
  createHash("sha256")
    .update("honeybee-agent-launch-trust-v1\0", "utf8")
    .update(
      JSON.stringify(
        files.map((file) => ({
          role: file.role,
          path: pathKey(file.path),
          byteLength: file.byteLength,
          sha256: file.sha256,
        })),
      ),
      "utf8",
    )
    .digest("hex");

export const captureAgentLaunchTrust = async (
  paths: readonly AgentTrustPath[],
): Promise<AgentLaunchTrustV1> => {
  if (paths.filter((candidate) => candidate.role === "entrypoint").length !== 1) {
    throw new HoneyBeeCoreError(
      "agent.trust-invalid",
      "Exactly one Agent entrypoint must be trusted.",
    );
  }
  const files: AgentLaunchTrustFileV1[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    const inspected = await inspectFile(candidate);
    const key = pathKey(inspected.path);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(inspected);
  }
  files.sort((left, right) => {
    if (left.role === "entrypoint") return -1;
    if (right.role === "entrypoint") return 1;
    return pathKey(left.path).localeCompare(pathKey(right.path));
  });
  return AgentLaunchTrustV1Schema.parse({
    schemaVersion: 1,
    files,
    trustDigest: trustDigest(files),
  });
};

export const verifyAgentLaunchTrust = async (
  command: AgentCommand,
  trustValue: AgentLaunchTrustV1,
): Promise<void> => {
  const trust = AgentLaunchTrustV1Schema.parse(trustValue);
  const entrypoint = trust.files.find((file) => file.role === "entrypoint");
  if (entrypoint === undefined || !path.isAbsolute(command.command)) {
    throw new HoneyBeeCoreError(
      "agent.trust-invalid",
      "The Agent command is not the trusted absolute entrypoint.",
    );
  }
  const commandPath = await realpath(command.command).catch(() => undefined);
  if (commandPath === undefined || pathKey(commandPath) !== pathKey(entrypoint.path)) {
    throw new HoneyBeeCoreError(
      "agent.trust-changed",
      "The Agent entrypoint no longer matches its approved trust receipt.",
    );
  }
  const actual = await captureAgentLaunchTrust(
    trust.files.map((file) => ({ role: file.role, path: file.path })),
  ).catch((error: unknown) => {
    if (error instanceof HoneyBeeCoreError && error.code === "agent.trust-invalid") {
      throw new HoneyBeeCoreError(
        "agent.trust-changed",
        "Approved Agent launch content is missing or unsafe.",
      );
    }
    throw error;
  });
  if (actual.trustDigest !== trust.trustDigest) {
    throw new HoneyBeeCoreError(
      "agent.trust-changed",
      "Approved Agent launch content changed and must be trusted again.",
    );
  }
};
