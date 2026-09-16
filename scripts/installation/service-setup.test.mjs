import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSetupService } from "./service-setup.mjs";

test("existing service Repair uses the shared startup primitive and validation", async () => {
  const calls = [];
  let ready = false;
  const result = await ensureSetupService({
    allowInstall: true,
    validate: async () => {
      calls.push("validate");
      if (!ready) throw new Error("stopped");
    },
    diagnose: async () => ({ serviceExists: true, receiptExists: true }),
    install: async () => {
      throw new Error("must not reinstall an existing service");
    },
    repairExisting: async () => {
      calls.push("repair");
      ready = true;
    },
    record: async (stage) => {
      calls.push(stage);
    },
    wait: async () => {},
  });
  assert.deepEqual(result, { ready: true, serviceAction: "repaired" });
  assert.deepEqual(calls, [
    "validate",
    "requested",
    "repair",
    "installer-completed",
    "validate",
    "validated",
  ]);
});

for (const scenario of [
  "ready",
  "silent",
  "existing",
  "receipt",
  "missing",
  "cancelled",
  "validation-failed",
  "query-failed",
]) {
  test(`service setup: ${scenario}`, async () => {
    const calls = [];
    let installed = false;
    const run = () =>
      ensureSetupService({
        allowInstall: scenario !== "silent",
        wait: async () => {},
        validate: async () => {
          calls.push("validate");
          if (scenario !== "ready" && (!installed || scenario === "validation-failed"))
            throw new Error("not ready");
        },
        diagnose: async () => {
          calls.push("diagnose");
          if (scenario === "query-failed") throw new Error("SCM unavailable");
          return { serviceExists: scenario === "existing", receiptExists: scenario === "receipt" };
        },
        install: async () => {
          calls.push("install");
          if (scenario === "cancelled") throw new Error("cancelled");
          installed = true;
        },
        record: async (stage) => {
          calls.push(stage);
        },
      });
    if (scenario === "query-failed") {
      await assert.rejects(run(), /SCM unavailable/);
      assert(!calls.includes("install"));
      return;
    }
    const result = await run();
    assert.equal(result.ready, scenario === "ready" || scenario === "missing");
    assert.equal(
      calls.includes("install"),
      ["missing", "cancelled", "validation-failed"].includes(scenario),
    );
    if (scenario === "missing")
      assert.deepEqual(calls, [
        "validate",
        "diagnose",
        "requested",
        "install",
        "installer-completed",
        "validate",
        "validated",
      ]);
    if (["cancelled", "validation-failed"].includes(scenario))
      assert.equal(calls.at(-1), "needs-attention");
  });
}

test("journal failure prevents elevation", async () => {
  let invoked = false;
  await assert.rejects(
    ensureSetupService({
      allowInstall: true,
      validate: async () => {
        throw new Error("missing");
      },
      diagnose: async () => ({}),
      install: async () => {
        invoked = true;
      },
      record: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(invoked, false);
});
