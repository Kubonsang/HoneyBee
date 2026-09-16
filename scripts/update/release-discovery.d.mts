import type { Buffer } from "node:buffer";
export interface ReleaseSource {
  currentVersion: string;
  bootstrapperVersion: string;
  channel: "beta" | "stable";
  storageComponentVersion: string;
}
export interface AvailableRelease {
  state: "Available";
  manifestUrl: string;
  signatureUrl: string;
  manifestBytes: Buffer;
  manifestSha256: string;
  signerKeyId: string;
  manifest: { version: string; mandatory: boolean };
}
export const releaseIndexUrl: string;
export function discoverRelease(options: {
  source: ReleaseSource;
  trustedPublicKeys: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<AvailableRelease | { state: "UpToDate" }>;
