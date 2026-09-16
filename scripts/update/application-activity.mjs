import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { plainDirectory } from "./stage-release.mjs";
import { packageTool } from "./prepare-release.mjs";

/** Internal cooperative gate. Callers must ensure every relevant app participates.
 * Exclusive ownership alone does not detect old/portable apps or external tools. */
const withFixedApplicationActivity = async (
  { installationRoot, mode, timeoutMs = 60000 },
  work,
) => {
  assert(["shared", "exclusive"].includes(mode), "Invalid activity mode");
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
    "Invalid activity timeout",
  );
  assert(typeof work === "function", "Activity callback required");
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  const directory = path.join(root, "update");
  await mkdir(directory, { recursive: true });
  await plainDirectory(directory);
  const child = spawn(packageTool, ["activity", directory, mode, String(timeoutMs)], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lost = new globalThis.AbortController();
  let resolveReady,
    rejectReady,
    received = "",
    diagnostics = "";
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise((resolve) => {
    child.once("error", (error) => {
      lost.abort(error);
      rejectReady(error);
    });
    child.once("close", (code, signal) => {
      const error = new Error(
        `Application activity unavailable or ownership lost (${code}/${signal}): ${diagnostics.trim()}`,
      );
      lost.abort(error);
      rejectReady(error);
      resolve();
    });
  });
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-8192);
  });
  child.stdout.on("data", (chunk) => {
    received += chunk.toString();
    const expected = mode === "exclusive" ? "DRAINING\nHELD\n" : "HELD\n";
    const normalized = received.replaceAll("\r\n", "\n");
    if (normalized === expected) resolveReady();
    else if (!expected.startsWith(normalized))
      rejectReady(new Error("Invalid activity helper response"));
  });
  const timer = setTimeout(() => {
    rejectReady(new Error("Activity acquisition timed out"));
    child.kill();
  }, timeoutMs + 5000);
  const assertHeld = () =>
    assert(
      !lost.signal.aborted && child.exitCode === null && child.signalCode === null,
      "Application activity ownership lost",
    );
  try {
    await ready;
    clearTimeout(timer);
    assertHeld();
    const result = await work({ assertHeld, signal: lost.signal });
    assertHeld();
    return result;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    const stop = setTimeout(() => child.kill(), 5000);
    try {
      await finished;
    } finally {
      clearTimeout(stop);
    }
  }
};

// Mode changes remain under the caller's separate installation-update lock.
// Combined validation may share activity only after its pending journal blocks
// ordinary clients. Mutations require exclusive activity again.
export async function withApplicationActivity(options, work) {
  let current,
    closing = false,
    switching = false;
  const lost = new globalThis.AbortController();
  const acquire = async (mode) => {
    let resolveReady, rejectReady, release;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const done = withFixedApplicationActivity({ ...options, mode }, async (lease) => {
      const abort = () => {
        if (!closing) lost.abort(lease.signal.reason);
      };
      lease.signal.addEventListener("abort", abort, { once: true });
      resolveReady({ ...lease, mode, release });
      try {
        await hold;
      } finally {
        lease.signal.removeEventListener("abort", abort);
      }
    });
    done.catch(rejectReady);
    const lease = await ready;
    current = { ...lease, done };
  };
  const relinquish = async () => {
    const previous = current;
    current = undefined;
    previous.release();
    await previous.done;
  };
  const assertHeld = () => {
    assert(current && !switching && !lost.signal.aborted, "Application activity ownership lost");
    current.assertHeld();
  };
  try {
    await acquire(options.mode);
    const result = await work({
      assertHeld,
      signal: lost.signal,
      assertExclusive: () => {
        assertHeld();
        assert.equal(current.mode, "exclusive");
      },
      setMode: async (mode) => {
        assert(["shared", "exclusive"].includes(mode));
        assertHeld();
        if (current.mode === mode) return;
        switching = true;
        try {
          await relinquish();
          await acquire(mode);
        } finally {
          switching = false;
        }
        assertHeld();
      },
    });
    assertHeld();
    return result;
  } finally {
    closing = true;
    if (current) await relinquish();
  }
}
