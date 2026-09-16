import type { ReleaseSource } from "./release-discovery.mjs";
export interface DownloadProgress {
  state: "Downloading" | "Verified";
  received: number;
  total: number;
}
export interface StageOptions {
  installationRoot: string;
  source: ReleaseSource;
  trustedPublicKeys: readonly string[];
  manifestUrl: string;
  signatureUrl: string;
  expectedManifestSha256: string;
  signal: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
}
export interface AuthenticatedStage {
  state: "Verified";
  attempt: string;
  version: string;
  manifestSha256: string;
  signerKeyId: string;
  activationAllowed: false;
}
export function stageAuthenticatedRelease(options: StageOptions): Promise<AuthenticatedStage>;
