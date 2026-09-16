import type { DesktopUpdateStatusV1 } from "../shared/ipc.js";
import type {
  StageOptions,
  AuthenticatedStage,
} from "../../../../scripts/update/authenticated-release.mjs";
import type {
  AvailableRelease,
  ReleaseSource,
} from "../../../../scripts/update/release-discovery.mjs";

type Discovery = (options: {
  source: ReleaseSource;
  trustedPublicKeys: readonly string[];
  signal: AbortSignal;
}) => Promise<AvailableRelease | { state: "UpToDate" }>;

/** The renderer supplies no URLs, keys, installation paths or source compatibility facts. */
export class DesktopUpdateCheck {
  private state: DesktopUpdateStatusV1 = {
    schemaVersion: 1,
    state: "Idle",
    version: null,
    mandatory: false,
  };
  private active: AbortController | undefined;
  private disposed = false;
  private offer: AvailableRelease | undefined;
  private downloadSettling = false;
  private restoreEligible = true;
  private preparation: { name: string; sha256: string } | undefined;
  public constructor(
    private readonly options: {
      source: () => Promise<ReleaseSource | undefined>;
      trustedPublicKeys: readonly string[];
      discover: Discovery;
      recordError?: (error: unknown) => void;
      restore?: () => Promise<DesktopUpdateStatusV1 | undefined>;
      installationRoot?: () => string;
      stage?: (options: StageOptions) => Promise<AuthenticatedStage>;
      prepare?: (options: {
        installationRoot: string;
        stage: AuthenticatedStage;
      }) => Promise<undefined | { name: string; sha256: string }>;
      apply?: (preparation: {
        name: string;
        sha256: string;
      }) => Promise<"Committed" | "RolledBack" | "Cancelled">;
    },
  ) {
    this.options = { ...options, trustedPublicKeys: Object.freeze([...options.trustedPublicKeys]) };
  }
  public status(): DesktopUpdateStatusV1 {
    return { ...this.state };
  }
  public async refresh(): Promise<DesktopUpdateStatusV1> {
    if (!this.restoreEligible || this.disposed || this.active || !this.options.restore)
      return this.status();
    const previous = this.state;
    try {
      const restored = await this.options.restore();
      if (
        this.restoreEligible &&
        !this.disposed &&
        !this.active &&
        this.state === previous &&
        restored
      ) {
        this.state = restored;
        this.restoreEligible = restored.state === "Unresolved";
      }
    } catch {
      /* Restoration cannot authorize work or interrupt startup. */
    }
    return this.status();
  }
  public check(): DesktopUpdateStatusV1 {
    this.restoreEligible = false;
    if (this.downloadSettling) return this.status();
    if (this.disposed || this.options.trustedPublicKeys.length === 0) {
      this.state = { schemaVersion: 1, state: "Unavailable", version: null, mandatory: false };
      return this.status();
    }
    if (this.active !== undefined) return this.status();
    const operation = new AbortController();
    this.active = operation;
    this.offer = undefined;
    this.preparation = undefined;
    this.state = { schemaVersion: 1, state: "Checking", version: null, mandatory: false };
    void this.run(operation);
    return this.status();
  }
  private async run(operation: AbortController): Promise<void> {
    try {
      const source = await this.options.source();
      if (this.active !== operation) return;
      if (source === undefined) {
        this.state = { schemaVersion: 1, state: "Unavailable", version: null, mandatory: false };
        return;
      }
      const result = await this.options.discover({
        source,
        trustedPublicKeys: this.options.trustedPublicKeys,
        signal: operation.signal,
      });
      if (this.active !== operation) return;
      this.offer = result.state === "Available" ? result : undefined;
      this.state = {
        schemaVersion: 1,
        state: result.state,
        version: result.state === "Available" ? result.manifest.version : null,
        mandatory: result.state === "Available" && result.manifest.mandatory,
      };
    } catch (error) {
      if (this.active !== operation) return;
      this.state = { schemaVersion: 1, state: "Failed", version: null, mandatory: false };
      try {
        this.options.recordError?.(error);
      } catch {
        /* Diagnostics cannot change admission. */
      }
    } finally {
      if (this.active === operation) this.active = undefined;
    }
  }
  public cancel(): DesktopUpdateStatusV1 {
    if (this.state.state === "Preparing" || this.state.state === "Applying") return this.status();
    if (this.active !== undefined) {
      const previous = this.active;
      this.active = undefined;
      previous.abort();
      this.state = { schemaVersion: 1, state: "Idle", version: null, mandatory: false };
    }
    return this.status();
  }
  public download(): DesktopUpdateStatusV1 {
    if (
      this.disposed ||
      this.active !== undefined ||
      this.downloadSettling ||
      this.offer === undefined ||
      this.options.stage === undefined ||
      this.options.installationRoot === undefined
    )
      return this.status();
    const offer = this.offer;
    const operation = new AbortController();
    this.active = operation;
    this.downloadSettling = true;
    this.state = {
      schemaVersion: 1,
      state: "Downloading",
      version: offer.manifest.version,
      mandatory: offer.manifest.mandatory,
    };
    void this.runDownload(operation, offer);
    return this.status();
  }
  private async runDownload(operation: AbortController, offer: AvailableRelease): Promise<void> {
    try {
      const source = await this.options.source();
      if (this.active !== operation) return;
      if (
        source === undefined ||
        this.options.stage === undefined ||
        this.options.installationRoot === undefined
      )
        throw new Error("Managed update source unavailable");
      const result = await this.options.stage({
        installationRoot: this.options.installationRoot(),
        source,
        trustedPublicKeys: this.options.trustedPublicKeys,
        manifestUrl: offer.manifestUrl,
        signatureUrl: offer.signatureUrl,
        expectedManifestSha256: offer.manifestSha256,
        signal: operation.signal,
        onProgress: (progress) => {
          if (this.active === operation)
            this.state = { ...this.state, received: progress.received, total: progress.total };
        },
      });
      if (this.active !== operation) return;
      if (
        result.state !== "Verified" ||
        result.manifestSha256 !== offer.manifestSha256 ||
        result.version !== offer.manifest.version
      )
        throw new Error("Unexpected staged release identity");
      this.state = { ...this.state, state: "Downloaded" };
      this.offer = undefined;
      if (this.options.prepare !== undefined) {
        this.state = { ...this.state, state: "Preparing" };
        const preparation = await this.options.prepare({
          installationRoot: this.options.installationRoot(),
          stage: result,
        });
        if (this.active !== operation || this.disposed) return;
        this.preparation = preparation || undefined;
        this.state = { ...this.state, state: "Prepared" };
      }
    } catch (error) {
      if (this.active !== operation) return;
      this.state = { schemaVersion: 1, state: "Failed", version: null, mandatory: false };
      this.offer = undefined;
      try {
        this.options.recordError?.(error);
      } catch {
        /* Preserve failure state. */
      }
    } finally {
      this.downloadSettling = false;
      if (this.active === operation) this.active = undefined;
    }
  }
  public dispose(): void {
    this.cancel();
    // Preparation owns its lifetime; closing Desktop only detaches observation.
    this.active = undefined;
    this.disposed = true;
  }

  public apply(): DesktopUpdateStatusV1 {
    if (
      this.disposed ||
      this.active ||
      this.downloadSettling ||
      this.state.state !== "Prepared" ||
      !this.preparation ||
      !this.options.apply
    )
      return this.status();
    const operation = new AbortController();
    this.active = operation;
    this.state = { ...this.state, state: "Applying" };
    void this.options
      .apply(this.preparation)
      .then((result) => {
        if (this.active !== operation || this.disposed) return;
        this.state = {
          ...this.state,
          state:
            result === "Cancelled" ? "Prepared" : result === "Committed" ? "Updated" : "RolledBack",
        };
      })
      .catch((error: unknown) => {
        if (this.active !== operation || this.disposed) return;
        this.state = { ...this.state, state: "Failed" };
        try {
          this.options.recordError?.(error);
        } catch {
          /* Preserve failure state. */
        }
      })
      .finally(() => {
        if (this.active === operation) this.active = undefined;
      });
    return this.status();
  }
}
