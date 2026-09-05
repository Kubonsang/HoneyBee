export const isSetupCheck = (item: { code: string }): boolean =>
  ["system.", "runtime.", "git.", "storage.", "registry."].some((prefix) =>
    item.code.startsWith(prefix),
  );

export const setupBlockers = <T extends { code: string; status: string }>(
  checks: readonly T[],
): T[] => checks.filter((item) => isSetupCheck(item) && item.status === "fail");
