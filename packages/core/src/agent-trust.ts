import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
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

const MAX_COMMAND_SHIM_BYTES = 64 * 1024;

export interface PreparedAgentLaunch {
  readonly command: AgentCommand;
  readonly trust: AgentLaunchTrustV1;
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

const resolvePathExecutable = async (command: string): Promise<string | undefined> => {
  if (path.isAbsolute(command)) return path.resolve(command);
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((value) => value.toLowerCase())
      : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const suppliedExtension = path.extname(command).toLowerCase();
    const candidates =
      process.platform === "win32" && suppliedExtension.length === 0
        ? extensions.map((extension) => path.join(directory, command + extension))
        : [path.join(directory, command)];
    for (const candidate of candidates) {
      const metadata = await lstat(candidate).catch(() => undefined);
      if (metadata?.isFile() === true && !metadata.isSymbolicLink()) return path.resolve(candidate);
    }
  }
  return undefined;
};

const regularExpressionLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const hasUnsupportedShimSetup = (source: string): boolean => {
  const allowedAssignments = new Set(["dp0", "_prog", "pathext"]);
  for (const line of source.split(/\r?\n/gu)) {
    for (const match of line.matchAll(/(?:^|[&|]\s*)@?\s*set\s+"?([a-z_][a-z0-9_]*)=/giu)) {
      if (match[1] !== undefined && !allowedAssignments.has(match[1].toLowerCase())) return true;
    }
    if (/(?:^|[&|]\s*)@?\s*(?:cd|chdir|pushd|popd)\b/iu.test(line)) return true;
  }
  return false;
};

const hasDirectShimInvocation = (
  source: string,
  targetTokens: readonly string[],
  requiresNode: boolean,
): boolean => {
  const nodeInterpreter =
    '(?:"(?:%_prog%|%dp0%[\\\\/][^"]*node\\.exe)"|(?:%_prog%|node(?:\\.exe)?|%dp0%[\\\\/]\\S*node\\.exe))';
  for (const line of source.split(/\r?\n/gu)) {
    const foldedLine = line.toLocaleLowerCase("en-US");
    for (const token of targetTokens) {
      const foldedToken = token.toLocaleLowerCase("en-US");
      let offset = 0;
      for (;;) {
        const targetIndex = foldedLine.indexOf(foldedToken, offset);
        if (targetIndex < 0) break;
        const separatorIndex = Math.max(
          line.lastIndexOf("&", targetIndex),
          line.lastIndexOf("|", targetIndex),
        );
        const prefix = line.slice(0, separatorIndex + 1).trim();
        if (
          separatorIndex >= 0 &&
          !/^endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s+\|\|\s+title\s+%comspec%\s*&$/iu.test(
            prefix,
          )
        ) {
          offset = targetIndex + token.length;
          continue;
        }
        const segment = line.slice(separatorIndex + 1).trim();
        const quotedTarget = `"?${regularExpressionLiteral(token)}"?`;
        const pattern = new RegExp(
          requiresNode
            ? `^${nodeInterpreter}\\s+${quotedTarget}\\s+%\\*\\s*$`
            : `^${quotedTarget}\\s+%\\*\\s*$`,
          "iu",
        );
        if (pattern.test(segment)) return true;
        offset = targetIndex + token.length;
      }
    }
  }
  return false;
};

const commandShimPayload = async (
  commandPath: string,
): Promise<
  Readonly<{
    payload: string;
    requiresNode?: true;
    localInterpreter?: string;
  }>
> => {
  const metadata = await lstat(commandPath).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_COMMAND_SHIM_BYTES
  ) {
    throw new HoneyBeeCoreError("agent.trust-invalid", "Agent command shim is unsafe.");
  }
  const source = await readFile(commandPath, "utf8");
  if (hasUnsupportedShimSetup(source)) {
    throw new HoneyBeeCoreError(
      "agent.trust-invalid",
      "The Agent command shim contains unsupported fixed arguments or setup.",
    );
  }
  const referenced = new Set<string>();
  const tokensByPath = new Map<string, Set<string>>();
  for (const match of source.matchAll(/%dp0%[\\/]([^"\r\n]+?\.(?:exe|[cm]?js))/giu)) {
    if (match[1] === undefined) continue;
    const candidate = path.resolve(path.dirname(commandPath), match[1]);
    const entry = await lstat(candidate).catch(() => undefined);
    if (entry?.isFile() !== true || entry.isSymbolicLink()) continue;
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical === undefined) continue;
    const canonicalEntry = await lstat(canonical).catch(() => undefined);
    if (canonicalEntry?.isFile() === true && !canonicalEntry.isSymbolicLink()) {
      const resolved = path.resolve(canonical);
      referenced.add(resolved);
      const key = pathKey(resolved);
      const tokens = tokensByPath.get(key) ?? new Set<string>();
      tokens.add(match[0]);
      tokensByPath.set(key, tokens);
    }
  }
  const scripts = [...referenced].filter((candidate) => /\.[cm]?js$/iu.test(candidate));
  const executables = [...referenced].filter(
    (candidate) =>
      path.extname(candidate).toLowerCase() === ".exe" &&
      path.basename(candidate).toLowerCase() !== "node.exe",
  );
  const script = scripts.length === 1 ? scripts[0] : undefined;
  if (script !== undefined && executables.length === 0) {
    const localNode = [...referenced].find(
      (candidate) => path.basename(candidate).toLowerCase() === "node.exe",
    );
    if (!hasDirectShimInvocation(source, [...(tokensByPath.get(pathKey(script)) ?? [])], true)) {
      throw new HoneyBeeCoreError(
        "agent.trust-invalid",
        "The Agent command shim contains unsupported fixed arguments or setup.",
      );
    }
    return {
      payload: script,
      requiresNode: true,
      ...(localNode === undefined ? {} : { localInterpreter: localNode }),
    };
  }
  const executable = executables.length === 1 ? executables[0] : undefined;
  if (scripts.length === 0 && executable !== undefined) {
    if (
      !hasDirectShimInvocation(source, [...(tokensByPath.get(pathKey(executable)) ?? [])], false)
    ) {
      throw new HoneyBeeCoreError(
        "agent.trust-invalid",
        "The Agent command shim contains unsupported fixed arguments or setup.",
      );
    }
    return { payload: executable };
  }
  throw new HoneyBeeCoreError(
    "agent.trust-invalid",
    "The Agent command shim must identify exactly one executable payload.",
  );
};

export const prepareAgentLaunch = async (
  commandValue: AgentCommand,
  explicitPayloadPaths: readonly string[] = [],
): Promise<PreparedAgentLaunch> => {
  const commandPath = await resolvePathExecutable(commandValue.command);
  if (commandPath === undefined) {
    throw new HoneyBeeCoreError(
      "agent.trust-invalid",
      "The Agent executable could not be resolved to an approved absolute path.",
    );
  }
  const command = { ...commandValue, command: commandPath };
  const trustPaths: AgentTrustPath[] = [{ role: "entrypoint", path: commandPath }];
  for (const candidate of explicitPayloadPaths) {
    trustPaths.push({ role: "payload", path: path.resolve(candidate) });
  }
  if (process.platform === "win32" && path.extname(commandPath).toLowerCase() === ".cmd") {
    const resolved = await commandShimPayload(commandPath);
    trustPaths.push({ role: "payload", path: resolved.payload });
    if (resolved.requiresNode === true) {
      const interpreter = resolved.localInterpreter ?? (await resolvePathExecutable("node.exe"));
      if (interpreter === undefined) {
        throw new HoneyBeeCoreError(
          "agent.trust-invalid",
          "The Agent command shim requires Node, but node.exe could not be resolved.",
        );
      }
      trustPaths.push({ role: "interpreter", path: interpreter });
    }
  }
  return { command, trust: await captureAgentLaunchTrust(trustPaths) };
};

export const trustedAgentInvocation = async (
  command: AgentCommand,
  trustValue: AgentLaunchTrustV1,
  args: readonly string[] = command.args ?? [],
): Promise<AgentCommand> => {
  const trust = AgentLaunchTrustV1Schema.parse(trustValue);
  if (process.platform !== "win32" || path.extname(command.command).toLowerCase() !== ".cmd") {
    return { ...command, args: [...args] };
  }
  const resolved = await commandShimPayload(command.command);
  const payload = trust.files.find(
    (file) => file.role === "payload" && pathKey(file.path) === pathKey(resolved.payload),
  );
  if (payload === undefined) {
    throw new HoneyBeeCoreError(
      "agent.trust-changed",
      "The Agent command shim target is not present in its approved trust receipt.",
    );
  }
  if (resolved.requiresNode === true) {
    const interpreters = trust.files.filter((file) => file.role === "interpreter");
    const interpreter = interpreters.length === 1 ? interpreters[0] : undefined;
    if (
      interpreter === undefined ||
      path.basename(interpreter.path).toLowerCase() !== "node.exe" ||
      (resolved.localInterpreter !== undefined &&
        pathKey(interpreter.path) !== pathKey(resolved.localInterpreter))
    ) {
      throw new HoneyBeeCoreError(
        "agent.trust-changed",
        "The Agent command shim interpreter is not present in its approved trust receipt.",
      );
    }
    return {
      ...command,
      command: interpreter.path,
      args: [payload.path, ...args],
    };
  }
  return { ...command, command: payload.path, args: [...args] };
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
