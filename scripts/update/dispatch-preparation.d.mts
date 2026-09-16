import type { AuthenticatedStage } from "./authenticated-release.mjs";
export function dispatchPreparation(options: {
  installationRoot: string;
  stage: AuthenticatedStage;
}): Promise<{ name: string; sha256: string }>;
export function dispatchActivation(options: {
  installationRoot: string;
  preparation: { name: string; sha256: string };
  desktopDescriptor: string;
}): Promise<"Committed" | "RolledBack" | "Cancelled">;
