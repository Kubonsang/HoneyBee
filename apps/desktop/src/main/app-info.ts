import path from "node:path";
import type { DesktopAppInfoV1 } from "../shared/ipc.js";

/** Installed identity is supplied only after readInstalledStorage validates this release. */
export function appInfo({
  packaged,
  buildVersion,
  releaseRoot,
  managed,
  checks,
}: {
  packaged: boolean;
  buildVersion: string;
  releaseRoot: string;
  managed: boolean;
  checks: readonly {
    code: string;
    actualVersion?: string | null | undefined;
    expectedVersion?: string | undefined;
  }[];
}): DesktopAppInfoV1 {
  const version = checks.find((check) => check.code === "storage.component-version");
  return {
    schemaVersion: 1,
    installation: managed ? "managed" : packaged ? "portable" : "development",
    applicationVersion: managed ? path.basename(releaseRoot) : buildVersion,
    installedStorageVersion: version?.actualVersion ?? null,
    requiredStorageVersion: version?.expectedVersion ?? null,
  };
}
