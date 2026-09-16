import { setTimeout } from "node:timers/promises";
/** Service-only orchestration. Dependencies are explicit so tests never invoke UAC. */
export const ensureSetupService = async ({
  allowInstall,
  diagnose,
  validate,
  install,
  repairExisting,
  record,
  wait = () => setTimeout(500),
}) => {
  try {
    await validate();
    return { ready: true, serviceAction: "none" };
  } catch (error) {
    if (!allowInstall) return { ready: false, serviceAction: "none", reason: error.message };
  }
  const state = await diagnose();
  const existing = state.serviceExists || state.receiptExists;
  if (
    existing &&
    !(state.serviceExists && state.receiptExists && typeof repairExisting === "function")
  ) {
    return {
      ready: false,
      serviceAction: "blocked",
      reason: "Existing storage requires diagnostics; automatic replacement is disabled.",
    };
  }
  await record("requested", { operation: existing ? "repair-start" : "install-fresh" });
  try {
    if (existing) await repairExisting();
    else await install();
    await record("installer-completed", {});
    for (let attempt = 0; ; attempt++) {
      try {
        await validate();
        break;
      } catch (error) {
        if (attempt === 29) throw error;
        await wait();
      }
    }
    await record("validated", {});
    return { ready: true, serviceAction: existing ? "repaired" : "installed" };
  } catch (error) {
    await record("needs-attention", { reason: error.message });
    return { ready: false, serviceAction: "needs-attention", reason: error.message };
  }
};
