import assert from "node:assert/strict";
import { ensureSetupService } from "./service-setup.mjs";

/** Shared Setup/Repair service path. Service replacement remains a separate
 * admitted migration. Never remove a receipt/store to turn repair into install. */
export async function repairInstalledComponents(options, hooks) {
  for (const name of ["verifyApplication", "diagnose", "validate", "install", "record", "doctor"])
    assert.equal(typeof hooks[name], "function", `Repair ${name} adapter required`);
  await hooks.record("repair-started", { schemaVersion: 1 });
  try {
    // Incomplete/corrupt application bytes must not be executed for service repair.
    await hooks.verifyApplication();
    const service = await ensureSetupService({
      allowInstall: options.allowServiceInstall === true,
      diagnose: hooks.diagnose,
      validate: hooks.validate,
      install: hooks.install,
      ...(hooks.repairExisting ? { repairExisting: hooks.repairExisting } : {}),
      record: hooks.record,
      ...(hooks.wait ? { wait: hooks.wait } : {}),
    });
    if (!service.ready) {
      const result = {
        schemaVersion: 1,
        ready: false,
        service,
        reason: service.reason,
        applicationAction: "verified",
        needsAttention: true,
      };
      await hooks.record("repair-incomplete", result);
      return result;
    }
    const doctor = await hooks.doctor();
    const ready = doctor?.ready === true && doctor?.summary?.fail === 0;
    const result = {
      schemaVersion: 1,
      ready,
      service,
      reason: ready ? undefined : "Doctor validation requires attention.",
      applicationAction: "verified",
      doctor,
      needsAttention: !ready,
    };
    await hooks.record(ready ? "repair-validated" : "repair-incomplete", result);
    return result;
  } catch (error) {
    await hooks.record("repair-failed", { schemaVersion: 1, reason: error.message });
    throw error;
  }
}
