import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  EditorContainmentReceiptV1Schema,
  EditorLaunchIntentV1Schema,
  type AgentCommand,
  type EditorContainmentReceiptV1,
  type EditorLaunchIntentV1,
} from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError } from "@honeybee/core";

import { SystemUnityProcessControl, type UnityProcessControl } from "./process-control.js";

const MAX_RECEIPT_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

const sameFileSystemPath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;

const parentPidOf = async (pid: number): Promise<number | undefined> => {
  if (process.platform === "win32") {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; [Console]::Out.Write($p.ParentProcessId)`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    const value = Number(stdout.trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields =
      end < 0
        ? []
        : stat
            .slice(end + 1)
            .trim()
            .split(/\s+/u);
    const value = Number(fields[1]);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  const value = Number(stdout.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const LAUNCHER_SOURCE = String.raw`
const { execFileSync, spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");

const fail = (message) => {
  try { if (process.connected) process.send({ type: "fatal", message }); } catch {}
  process.exitCode = 1;
};
const identity = () => {
  if (process.platform === "win32") {
    const script = '$p = Get-Process -Id ' + process.pid + ' -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)';
    const ticks = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
    if (!/^\d+$/.test(ticks)) throw new Error("invalid Windows process identity");
    return "win32:" + ticks;
  }
  if (process.platform === "linux") {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8");
    const end = stat.lastIndexOf(")");
    const fields = end < 0 ? [] : stat.slice(end + 1).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] || "")) throw new Error("invalid Linux process identity");
    return "linux:" + boot + ":" + fields[19];
  }
  const started = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim().replace(/\s+/g, " ");
  if (!started) throw new Error("invalid process identity");
  return process.platform + ":" + started;
};
const publish = (receiptPath, receipt) => {
  const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const temporary = receiptPath + "." + randomUUID() + ".tmp";
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, receiptPath);
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(receiptPath);
    if (!existing.equals(bytes)) throw new Error("containment receipt already exists with different identity");
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  const published = fs.readFileSync(receiptPath);
  if (!published.equals(bytes)) throw new Error("published containment receipt changed");
  return createHash("sha256").update(published).digest("hex");
};

let intent;
try {
  intent = JSON.parse(Buffer.from(process.env.HONEYBEE_EDITOR_LAUNCH_INTENT || "", "base64").toString("utf8"));
  delete process.env.HONEYBEE_EDITOR_LAUNCH_INTENT;
  const receipt = {
    schemaVersion: 1,
    launchId: intent.launchId,
    nonce: intent.nonce,
    containmentPid: process.pid,
    processIdentity: identity(),
    containmentProtocol: "editor-deferred-v1",
    poolId: intent.poolId,
    slotId: intent.slotId,
    poolLeaseId: intent.poolLeaseId,
    workspaceId: intent.workspaceId,
    publishedAt: new Date().toISOString(),
  };
  const digest = publish(intent.containmentReceiptPath, receipt);
  if (!process.connected) throw new Error("launcher IPC is unavailable");
  process.send({ type: "ready", receiptPath: intent.containmentReceiptPath, digest });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let activated = false;
let ownershipCommitted = false;
let editor;
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "activate" && !activated) {
    if (message.launchId !== intent.launchId || message.nonce !== intent.nonce) {
      fail("activation identity mismatch");
      return;
    }
    activated = true;
    try {
      editor = spawn(message.command, message.args, {
        cwd: intent.projectPath,
        env: message.targetEnvironment,
        shell: false,
        windowsHide: false,
        stdio: "ignore",
      });
      editor.once("spawn", () => process.send({ type: "editor-started", pid: editor.pid }));
      editor.once("error", () => process.send({ type: "editor-error" }));
      editor.once("close", (exitCode, signal) => {
        process.send({ type: "editor-exited", exitCode, signal, ownershipCommitted });
      });
    } catch {
      process.send({ type: "editor-error" });
    }
    return;
  }
  if (message.type === "ownership-committed" && activated) {
    if (message.launchId !== intent.launchId || message.nonce !== intent.nonce) {
      fail("ownership acknowledgement mismatch");
      return;
    }
    ownershipCommitted = true;
    process.send({ type: "ownership-acknowledged" });
  }
});
process.on("disconnect", () => {
  // The durable receipt keeps this containment tree recoverable. Never detach
  // or exit merely because the HoneyBee parent crashed.
});
setInterval(() => {}, 1000);
`;

const internalLauncherEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  const allowed =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new HoneyBeeCoreError("editor.launch-timeout", message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });

const messagePromise = <T>(
  child: ChildProcess,
  accept: (message: Record<string, unknown>) => T | undefined,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value)) return;
      const message = value as Record<string, unknown>;
      if (message.type === "fatal" || message.type === "editor-error") {
        cleanup();
        reject(
          new HoneyBeeCoreError("editor.launch-failed", "Editor containment launcher failed."),
        );
        return;
      }
      const result = accept(message);
      if (result !== undefined) {
        cleanup();
        resolve(result);
      }
    };
    const onExit = () => {
      cleanup();
      reject(
        new HoneyBeeCoreError("editor.launch-failed", "Editor containment launcher exited early."),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });

const readReceipt = async (
  intent: EditorLaunchIntentV1,
  validatedDirectory: string,
  expectedPid: number | undefined,
  expectedDigest: string | undefined,
  processes: UnityProcessControl,
): Promise<EditorContainmentReceiptV1> => {
  if (
    !sameFileSystemPath(
      path.dirname(path.resolve(intent.containmentReceiptPath)),
      path.resolve(validatedDirectory),
    )
  ) {
    throw new HoneyBeeCoreError(
      "editor.receipt-invalid",
      "Containment receipt escaped its directory.",
    );
  }
  const initial = await lstat(intent.containmentReceiptPath);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1 ||
    initial.size > MAX_RECEIPT_BYTES
  ) {
    throw new HoneyBeeCoreError(
      "editor.receipt-invalid",
      "Containment receipt is not a private bounded file.",
    );
  }
  const handle = await open(intent.containmentReceiptPath, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size > MAX_RECEIPT_BYTES
    ) {
      throw new HoneyBeeCoreError(
        "editor.receipt-invalid",
        "Containment receipt changed while opening.",
      );
    }
    bytes = Buffer.alloc(opened.size);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (result.bytesRead !== bytes.byteLength) {
      throw new HoneyBeeCoreError("editor.receipt-invalid", "Containment receipt is incomplete.");
    }
  } finally {
    await handle.close();
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new HoneyBeeCoreError(
      "editor.receipt-invalid",
      "Containment ready digest does not match its receipt.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new HoneyBeeCoreError("editor.receipt-invalid", "Containment receipt is malformed.");
  }
  const receipt = EditorContainmentReceiptV1Schema.parse(parsed);
  if (
    receipt.launchId !== intent.launchId ||
    receipt.nonce !== intent.nonce ||
    (expectedPid !== undefined && receipt.containmentPid !== expectedPid) ||
    receipt.poolId !== intent.poolId ||
    receipt.slotId !== intent.slotId ||
    receipt.poolLeaseId !== intent.poolLeaseId ||
    receipt.workspaceId !== intent.workspaceId
  ) {
    throw new HoneyBeeCoreError(
      "editor.receipt-invalid",
      "Containment receipt does not match launch intent.",
    );
  }
  const actualIdentity = await processes.captureIdentity(receipt.containmentPid);
  if (actualIdentity !== receipt.processIdentity) {
    throw new HoneyBeeCoreError("editor.receipt-invalid", "Containment process identity changed.");
  }
  return receipt;
};

export interface UnityEditorLaunchCandidate {
  readonly pid: number;
  readonly processIdentity: string;
}

export interface UnityEditorLaunchHandle {
  readonly containment: EditorContainmentReceiptV1;
  readonly editor: UnityEditorLaunchCandidate;
  stop(): Promise<void>;
}

export interface UnityEditorLauncher {
  launch(
    intent: EditorLaunchIntentV1,
    command: AgentCommand,
    lifecycle: Readonly<{
      onContainmentReady(receipt: EditorContainmentReceiptV1): Promise<void>;
      onActivated(): Promise<void>;
      onEditorStarted(editor: UnityEditorLaunchCandidate): Promise<void>;
    }>,
  ): Promise<UnityEditorLaunchHandle>;
  recoverPublishedReceipt(
    intent: EditorLaunchIntentV1,
  ): Promise<EditorContainmentReceiptV1 | undefined>;
  drainContainment(receipt: EditorContainmentReceiptV1, timeoutMs?: number): Promise<void>;
}

export class SystemUnityEditorLauncher implements UnityEditorLauncher {
  public constructor(
    private readonly trustedRoot?: string,
    private readonly processes: UnityProcessControl = new SystemUnityProcessControl(),
  ) {}

  async #validateReceiptDirectory(intent: EditorLaunchIntentV1): Promise<string> {
    const receiptDirectory = path.dirname(intent.containmentReceiptPath);
    if (this.trustedRoot === undefined) {
      const entry = await lstat(receiptDirectory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new HoneyBeeCoreError(
          "editor.receipt-invalid",
          "Containment receipt directory is not real.",
        );
      }
      return receiptDirectory;
    }

    const root = path.resolve(this.trustedRoot);
    const components = [intent.ownerRunId, "control"];
    const expectedDirectory = path.join(root, ...components);
    if (!sameFileSystemPath(path.resolve(receiptDirectory), expectedDirectory)) {
      throw new HoneyBeeCoreError(
        "editor.receipt-invalid",
        "Containment receipt path is outside its Run control directory.",
      );
    }

    let candidate = root;
    for (const component of components) {
      candidate = path.join(candidate, component);
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new HoneyBeeCoreError(
          "editor.receipt-invalid",
          "Containment receipt path contains a filesystem link.",
        );
      }
    }
    const [physicalRoot, physicalDirectory] = await Promise.all([
      realpath(root),
      realpath(receiptDirectory),
    ]);
    const expectedPhysicalDirectory = path.join(physicalRoot, ...components);
    if (!sameFileSystemPath(physicalDirectory, expectedPhysicalDirectory)) {
      throw new HoneyBeeCoreError(
        "editor.receipt-invalid",
        "Containment receipt directory escaped the state root.",
      );
    }
    return receiptDirectory;
  }

  public async launch(
    intentValue: EditorLaunchIntentV1,
    command: AgentCommand,
    lifecycle: Readonly<{
      onContainmentReady(receipt: EditorContainmentReceiptV1): Promise<void>;
      onActivated(): Promise<void>;
      onEditorStarted(editor: UnityEditorLaunchCandidate): Promise<void>;
    }>,
  ): Promise<UnityEditorLaunchHandle> {
    const intent = EditorLaunchIntentV1Schema.parse(intentValue);
    const commandPath = path.resolve(command.command);
    const sameExecutable =
      process.platform === "win32"
        ? commandPath.toLocaleLowerCase("en-US") ===
          path.resolve(intent.unityExecutablePath).toLocaleLowerCase("en-US")
        : commandPath === path.resolve(intent.unityExecutablePath);
    const commandDigest = `sha256:${createHash("sha256")
      .update(await readFile(commandPath))
      .digest("hex")}`;
    if (!sameExecutable || commandDigest !== intent.unityExecutableDigest) {
      throw new HoneyBeeCoreError(
        "editor.receipt-invalid",
        "Editor launch command does not match the durable pinned intent.",
      );
    }
    const receiptDirectory = await this.#validateReceiptDirectory(intent);
    const launcherEnvironment = internalLauncherEnvironment();
    launcherEnvironment.HONEYBEE_EDITOR_LAUNCH_INTENT = Buffer.from(
      JSON.stringify(intent),
      "utf8",
    ).toString("base64");
    const child = spawn(process.execPath, ["-e", LAUNCHER_SOURCE], {
      cwd: intent.projectPath,
      env: launcherEnvironment,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    // The launcher can publish its receipt immediately after spawn. Register the
    // IPC listener before yielding for the spawn event so a fast child cannot
    // publish `ready` into the gap and leave the durable handshake waiting.
    const readyMessage = messagePromise(child, (message) =>
      message.type === "ready" &&
      message.receiptPath === intent.containmentReceiptPath &&
      typeof message.digest === "string"
        ? { digest: message.digest }
        : undefined,
    );
    // A spawn failure can reject both promises before the function awaits the
    // ready message. Keep that early rejection observed while preserving it for
    // the awaited handshake below.
    void readyMessage.catch(() => undefined);
    const pid = await withTimeout(
      new Promise<number>((resolve, reject) => {
        child.once("spawn", () => {
          if (child.pid === undefined) reject(new Error("missing containment PID"));
          else resolve(child.pid);
        });
        child.once("error", reject);
      }),
      intent.registrationTimeoutMs,
      "Editor containment launcher did not start in time.",
    );
    try {
      const ready = await withTimeout(
        readyMessage,
        intent.registrationTimeoutMs,
        "Editor containment launcher did not publish its receipt in time.",
      );
      const receipt = await readReceipt(
        intent,
        receiptDirectory,
        pid,
        ready.digest,
        this.processes,
      );
      await lifecycle.onContainmentReady(receipt);
      const editorStarted = messagePromise(child, (message) =>
        message.type === "editor-started" &&
        Number.isInteger(message.pid) &&
        (message.pid as number) > 0
          ? (message.pid as number)
          : undefined,
      );
      child.send({
        type: "activate",
        launchId: intent.launchId,
        nonce: intent.nonce,
        command: command.command,
        args: command.args ?? [],
        targetEnvironment: { ...process.env, ...command.env },
      });
      await lifecycle.onActivated();
      const editorPid = await withTimeout(
        editorStarted,
        intent.activationTimeoutMs,
        "Unity Editor did not start in time.",
      );
      const editorIdentity = await this.processes.captureIdentity(editorPid);
      if (editorIdentity === undefined) {
        throw new HoneyBeeCoreError(
          "process.identity-failed",
          "Unity Editor exited before ownership could be established.",
        );
      }
      if ((await parentPidOf(editorPid).catch(() => undefined)) !== receipt.containmentPid) {
        throw new HoneyBeeCoreError(
          "editor.ownership-failed",
          "Unity Editor is not a direct child of the durable containment process.",
        );
      }
      const editor = { pid: editorPid, processIdentity: editorIdentity };
      await lifecycle.onEditorStarted(editor);
      const acknowledged = messagePromise(child, (message) =>
        message.type === "ownership-acknowledged" ? true : undefined,
      );
      child.send({ type: "ownership-committed", launchId: intent.launchId, nonce: intent.nonce });
      await withTimeout(
        acknowledged,
        intent.activationTimeoutMs,
        "Editor ownership acknowledgement timed out.",
      );
      return {
        containment: receipt,
        editor,
        stop: () => this.drainContainment(receipt, intent.shutdownTimeoutMs),
      };
    } catch (error) {
      const identity = await this.processes.captureIdentity(pid).catch(() => undefined);
      if (identity !== undefined) {
        await withTimeout(
          this.processes.drain(pid, identity, "safe"),
          intent.shutdownTimeoutMs,
          "Editor containment cleanup timed out.",
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  public async drainContainment(
    receiptValue: EditorContainmentReceiptV1,
    timeoutMs = 120_000,
  ): Promise<void> {
    const receipt = EditorContainmentReceiptV1Schema.parse(receiptValue);
    await withTimeout(
      this.processes.drain(receipt.containmentPid, receipt.processIdentity, "safe"),
      timeoutMs,
      "Editor containment cleanup timed out.",
    );
  }

  public async recoverPublishedReceipt(
    intentValue: EditorLaunchIntentV1,
  ): Promise<EditorContainmentReceiptV1 | undefined> {
    const intent = EditorLaunchIntentV1Schema.parse(intentValue);
    try {
      const receiptDirectory = await this.#validateReceiptDirectory(intent);
      return await readReceipt(intent, receiptDirectory, undefined, undefined, this.processes);
    } catch (error) {
      if (errorCodeFor(error) === "ENOENT") return undefined;
      throw error;
    }
  }
}

const errorCodeFor = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
