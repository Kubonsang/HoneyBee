import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import path from "node:path";

const limit = 24 * 1024 * 1024;

/** One service-only UAC session across a combined update. The native parent
 * authenticates the elevated pipe peer against ShellExecute's process handle.
 * No PowerShell interpolation, temporary privileged command or result file. */
export function createServiceUpdateSession({ executable, spawnProcess = spawn }) {
  assert(path.isAbsolute(executable), "Absolute service companion required");
  const child = spawnProcess(executable, ["service-update-elevated"], {
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending,
    failure,
    exited,
    closing = false;
  let buffered = Buffer.alloc(0),
    stderr = "";
  let tail = Promise.resolve();
  const fail = (error) => {
    failure ??= error;
    if (pending) {
      const reject = pending.reject;
      pending = undefined;
      reject(failure);
    }
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString("utf8")).slice(-16384);
  });
  const completion = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      exited = { code, signal };
      if (pending || code !== 0 || !closing || buffered.length !== 0) {
        const error = new Error(
          stderr.trim() || `Service update session exited (${code ?? signal})`,
        );
        error.code = code === 24 ? "ELEVATION_CANCELLED" : "SERVICE_SESSION_EXITED";
        fail(error);
      }
      resolve(exited);
    });
  });
  child.stdout.on("data", (bytes) => {
    if (failure) return;
    try {
      assert(buffered.length + bytes.length <= limit + 4, "Service response exceeds bound");
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      assert(length > 0 && length <= limit, "Invalid service response length");
      if (buffered.length < length + 4) return;
      assert(pending, "Unexpected service response");
      assert.equal(buffered.length, length + 4, "Unexpected extra service response bytes");
      const response = JSON.parse(buffered.subarray(4).toString("utf8"));
      buffered = Buffer.alloc(0);
      assert.equal(response.schemaVersion, 1);
      assert.equal(typeof response.ok, "boolean");
      if (response.ok) assert(response.result?.schemaVersion === 1 && response.result.ok === true);
      else assert.equal(typeof response.error, "string");
      const request = pending;
      pending = undefined;
      if (!response.ok) {
        const error = new Error(`Service update ${request.operation} failed: ${response.error}`);
        error.code = "SERVICE_REQUEST_FAILED";
        error.operation = request.operation;
        request.reject(error);
      } else {
        request.resolve(response.result);
      }
    } catch (error) {
      fail(error);
    }
  });
  const request = (value) => {
    const operation = tail.then(async () => {
      if (failure) throw failure;
      assert(!closing && !exited, "Service update session is closed");
      const bytes = Buffer.from(JSON.stringify(value));
      assert(bytes.length > 0 && bytes.length <= limit, "Service request exceeds bound");
      const frame = Buffer.allocUnsafe(4 + bytes.length);
      frame.writeUInt32LE(bytes.length);
      bytes.copy(frame, 4);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, operation: value.operation };
        child.stdin.write(frame, (error) => {
          if (error) fail(error);
        });
      });
    });
    // A refused prepare can still be followed by an explicit recovery command.
    tail = operation.catch(() => {});
    return operation;
  };
  return {
    request,
    async close() {
      await tail;
      closing = true;
      child.stdin.end();
      await completion;
      if (failure) throw failure;
    },
  };
}
