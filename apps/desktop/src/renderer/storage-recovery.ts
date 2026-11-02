/** Display classification only. Repair/update admission remains in the main/native processes. */
export const storageRecoveryState = (
  checks: readonly { code: string; status: string; actualVersion?: string | null | undefined }[],
): "identity" | "legacy" | "version" | "service" | "ready" | "attention" => {
  const failures = new Set(
    checks.filter((item) => item.status === "fail").map((item) => item.code),
  );
  if (failures.has("storage.install-receipt")) return "identity";
  if (failures.has("storage.component-version")) {
    const version = checks.find((item) => item.code === "storage.component-version");
    return version?.actualVersion?.endsWith(".hb12") ? "legacy" : "version";
  }
  if (failures.has("storage.service")) return "service";
  const storage = checks.filter((item) => item.code.startsWith("storage."));
  return storage.length > 0 && storage.every((item) => item.status === "pass")
    ? "ready"
    : "attention";
};
