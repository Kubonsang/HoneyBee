export function readUpdateOutcome(root: string): Promise<
  | undefined
  | {
      schemaVersion: 1;
      state: "Updated" | "RolledBack" | "Failed" | "Unresolved" | "UpdateCancelled";
      version: string | null;
      mandatory: false;
    }
>;
