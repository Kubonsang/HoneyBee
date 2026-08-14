import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { HoneyBeeCoreError } from "@honeybee/core";

const execFileAsync = promisify(execFile);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

const readProcessIdentity = async (pid: number): Promise<string> => {
  if (process.platform === "win32") {
    const command =
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      "[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    const ticks = stdout.trim();
    if (!/^\d+$/u.test(ticks)) throw new Error("Invalid Windows process creation time.");
    return `win32:${ticks}`;
  }
  if (process.platform === "linux") {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    const fields =
      commandEnd < 0
        ? []
        : stat
            .slice(commandEnd + 1)
            .trim()
            .split(/\s+/u);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
      throw new Error("Invalid Linux process start time.");
    }
    return `linux:${bootId.trim()}:${startTicks}`;
  }
  const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  const startedAt = stdout.trim().replace(/\s+/gu, " ");
  if (startedAt.length === 0) throw new Error("Missing process creation time.");
  return `${process.platform}:${startedAt}`;
};

interface ProcessObservation {
  readonly status: "alive" | "missing";
  readonly identity?: string;
}

const observeProcess = async (pid: number): Promise<ProcessObservation> => {
  if (!processExists(pid)) return { status: "missing" };
  try {
    return { status: "alive", identity: await readProcessIdentity(pid) };
  } catch {
    return processExists(pid) ? { status: "alive" } : { status: "missing" };
  }
};

const waitForOriginalExit = async (pid: number, identity: string): Promise<boolean> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await observeProcess(pid);
    if (observation.status === "missing" || observation.identity !== identity) return true;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }
  return false;
};

export interface UnityProcessControl {
  captureIdentity(pid: number): Promise<string | undefined>;
  drain(pid: number, processIdentity?: string): Promise<void>;
}

export class SystemUnityProcessControl implements UnityProcessControl {
  public async captureIdentity(pid: number): Promise<string | undefined> {
    const observation = await observeProcess(pid);
    if (observation.status === "missing") return undefined;
    if (observation.identity === undefined) {
      throw new HoneyBeeCoreError(
        "process.identity-failed",
        "Could not establish the child process identity before persisting its start.",
      );
    }
    return observation.identity;
  }

  public async drain(pid: number, processIdentity?: string): Promise<void> {
    const observation = await observeProcess(pid);
    if (observation.status === "missing") return;
    if (processIdentity === undefined || observation.identity === undefined) {
      throw new HoneyBeeCoreError(
        "process.drain-failed",
        "A surviving child process cannot be identified safely.",
      );
    }
    if (observation.identity !== processIdentity) return;

    try {
      if (process.platform === "win32") {
        await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      const afterFailure = await observeProcess(pid);
      if (afterFailure.status === "missing" || afterFailure.identity !== processIdentity) return;
    }

    if (await waitForOriginalExit(pid, processIdentity)) return;
    if (process.platform !== "win32") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may have exited between the observation and the signal.
      }
      if (await waitForOriginalExit(pid, processIdentity)) return;
    }
    throw new HoneyBeeCoreError(
      "process.drain-failed",
      "The surviving child process tree could not be drained before workspace cleanup.",
    );
  }
}
