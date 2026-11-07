export function readUpdateOutcome(
  root: string,
  expected?: { sourcePointerSha256: string; manifestSha256: string },
): Promise<
  | undefined
  | {
      schemaVersion: 1;
      state: "Updated" | "RolledBack" | "Failed" | "Unresolved" | "UpdateCancelled";
      version: string | null;
      mandatory: false;
    }
>;
