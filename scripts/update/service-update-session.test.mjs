import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
const queueMicrotask = globalThis.queueMicrotask;
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import test from "node:test";
import { createServiceUpdateSession } from "./service-update-session.mjs";

function fixture(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const requests = [];
  child.stdin = new Writable({
    write(bytes, _, done) {
      try {
        assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
        const request = JSON.parse(bytes.subarray(4));
        requests.push(request);
        handle(request, child);
        done();
      } catch (error) {
        done(error);
      }
    },
    final(done) {
      done();
      queueMicrotask(() => child.emit("close", 0, null));
    },
  });
  const session = createServiceUpdateSession({
    executable: path.resolve("host.exe"),
    spawnProcess(executable, args, options) {
      assert.equal(executable, path.resolve("host.exe"));
      assert.deepEqual(args, ["service-update-elevated"]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return child;
    },
  });
  return { session, requests, child };
}
function reply(child, value, split = false) {
  const bytes = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32LE(bytes.length);
  bytes.copy(frame, 4);
  if (split) {
    child.stdout.write(frame.subarray(0, 2));
    child.stdout.write(frame.subarray(2, 9));
    child.stdout.write(frame.subarray(9));
  } else child.stdout.write(frame);
}
test("one elevated session serializes stage, prepare and commit with split frames", async () => {
  const { session, requests } = fixture((request, child) =>
    queueMicrotask(() =>
      reply(
        child,
        {
          schemaVersion: 1,
          ok: true,
          result: { schemaVersion: 1, ok: true, state: request.operation },
        },
        true,
      ),
    ),
  );
  const results = await Promise.all(
    ["stage", "prepare", "commit"].map((operation) =>
      session.request({ schemaVersion: 1, operation }),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.state),
    ["stage", "prepare", "commit"],
  );
  assert.equal(requests.length, 3);
  await session.close();
});
test("refused prepare leaves the same session available for recovery", async () => {
  const { session } = fixture((request, child) =>
    reply(
      child,
      request.operation === "prepare"
        ? { schemaVersion: 1, ok: false, error: "volume is busy" }
        : {
            schemaVersion: 1,
            ok: true,
            result: { schemaVersion: 1, ok: true, state: "RolledBack" },
          },
    ),
  );
  await assert.rejects(session.request({ operation: "prepare" }), {
    message: "Service update prepare failed: volume is busy",
    code: "SERVICE_REQUEST_FAILED",
    operation: "prepare",
  });
  assert.equal((await session.request({ operation: "recover" })).state, "RolledBack");
  await session.close();
});
test("UAC cancellation is a failure, never a successful service update", async () => {
  const { session, child } = fixture(() => queueMicrotask(() => child.emit("close", 24, null)));
  await assert.rejects(session.request({ operation: "stage" }), { code: "ELEVATION_CANCELLED" });
  await assert.rejects(session.close(), { code: "ELEVATION_CANCELLED" });
});
test("oversized or malformed output rejects the waiting request", async () => {
  for (const malformed of [Buffer.from([255, 255, 255, 127]), Buffer.from([1, 0, 0, 0, 123])]) {
    const { session } = fixture((_, child) => child.stdout.write(malformed));
    await assert.rejects(session.request({ operation: "status" }));
    await assert.rejects(session.close());
  }
});
