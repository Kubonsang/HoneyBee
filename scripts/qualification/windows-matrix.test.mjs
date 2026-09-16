import assert from "node:assert/strict";
import test from "node:test";
import { waitFile } from "./windows-matrix.mjs";

function clock(read) {
  let time = 0;
  return {
    read,
    now: () => time,
    pause: async (ms) => {
      time += ms;
    },
  };
}
test("readiness polling tolerates sharing violations on either evidence file", async () => {
  for (const locked of ["native-ready.json", "native-error.json"]) {
    let count = 0;
    const options = clock(async (file) => {
      if (file.endsWith(locked) && count++ < 2)
        throw Object.assign(Error("sharing violation"), { code: "EBUSY" });
      return file.endsWith("native-ready.json") ? { configSha256: "bound" } : null;
    });
    assert.deepEqual(await waitFile("case", "native-ready.json", 1000, () => {}, options), {
      configSha256: "bound",
    });
  }
});
test("persistent locks expire and worker exit checks still run", async () => {
  const busy = async () => {
    throw Object.assign(Error("locked"), { code: "EBUSY" });
  };
  let checks = 0;
  await assert.rejects(
    waitFile("case", "native-ready.json", 300, () => checks++, clock(busy)),
    /timeout/,
  );
  assert.equal(checks, 3);
  await assert.rejects(
    waitFile(
      "case",
      "native-ready.json",
      300,
      () => {
        throw Error("worker exited");
      },
      clock(busy),
    ),
    /worker exited/,
  );
});
test("invalid JSON, denied access and native failures are not retried", async () => {
  for (const error of [
    new SyntaxError("invalid JSON"),
    Object.assign(Error("denied"), { code: "EACCES" }),
  ]) {
    await assert.rejects(
      waitFile(
        "case",
        "native-ready.json",
        1000,
        () => {},
        clock(async () => {
          throw error;
        }),
      ),
      (e) => e === error,
    );
  }
  await assert.rejects(
    waitFile(
      "case",
      "native-ready.json",
      1000,
      () => {},
      clock(async () => ({ error: "native failure" })),
    ),
    /native failure/,
  );
});
