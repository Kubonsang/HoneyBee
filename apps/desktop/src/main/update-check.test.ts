import { expect, it, vi } from "vitest";
import { DesktopUpdateCheck } from "./update-check.js";
import type {
  StageOptions,
  AuthenticatedStage,
} from "../../../../scripts/update/authenticated-release.mjs";
import type {
  AvailableRelease,
  ReleaseSource,
} from "../../../../scripts/update/release-discovery.mjs";
const source: ReleaseSource = {
  currentVersion: "0.1.0-beta.11",
  bootstrapperVersion: "1.0.0",
  channel: "beta",
  storageComponentVersion: "test.hb12",
};
const available = {
  state: "Available",
  manifest: { version: "0.1.0-beta.12", mandatory: false },
} as AvailableRelease;
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const offer = {
  ...available,
  manifestUrl:
    "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.12/release.json",
  signatureUrl:
    "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.12/release.sig.json",
  manifestSha256: "a".repeat(64),
};
const staged: AuthenticatedStage = {
  state: "Verified",
  attempt: "case/update/stage-1",
  version: "0.1.0-beta.12",
  manifestSha256: "a".repeat(64),
  signerKeyId: "b".repeat(64),
  activationAllowed: false,
};

it("preparation runs once, cannot be cancelled as a download, and exposes no job paths", async () => {
  let finish!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    installationRoot: () => "managed-root",
    stage: async () => staged,
    prepare,
  });
  controller.check();
  await tick();
  controller.download();
  await tick();
  expect(controller.status().state).toBe("Preparing");
  expect(controller.cancel().state).toBe("Preparing");
  controller.check();
  controller.download();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledWith({ installationRoot: "managed-root", stage: staged });
  finish();
  await tick();
  expect(controller.status().state).toBe("Prepared");
  expect(controller.status()).not.toHaveProperty("attempt");
});

it("worker failure is not shown as prepared", async () => {
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    installationRoot: () => "managed-root",
    stage: async () => staged,
    prepare: async () => {
      throw new Error("source not recoverable");
    },
  });
  controller.check();
  await tick();
  controller.download();
  await tick();
  await tick();
  expect(controller.status().state).toBe("Failed");
});

it("Desktop disposal detaches worker completion without starting another job", async () => {
  let finish!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    installationRoot: () => "managed-root",
    stage: async () => staged,
    prepare,
  });
  controller.check();
  await tick();
  controller.download();
  await tick();
  controller.dispose();
  finish();
  await tick();
  expect(controller.status().state).not.toBe("Prepared");
  controller.download();
  expect(prepare).toHaveBeenCalledTimes(1);
});

it("download needs a main-owned offer and refreshes source facts before staging", async () => {
  const stage = vi.fn(async (options: StageOptions) => {
    expect(options.expectedManifestSha256).toBe(offer.manifestSha256);
    expect(options.manifestUrl).toBe(offer.manifestUrl);
    expect(options.installationRoot).toBe("managed-root");
    options.onProgress({ state: "Downloading", received: 5, total: 10 });
    return staged;
  });
  const read = vi.fn(async () => source);
  const controller = new DesktopUpdateCheck({
    source: read,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    stage,
    installationRoot: () => "managed-root",
  });
  expect(controller.download().state).toBe("Idle");
  expect(stage).not.toHaveBeenCalled();
  controller.check();
  await tick();
  expect(controller.download().state).toBe("Downloading");
  controller.download();
  await tick();
  expect(stage).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(controller.status()).toMatchObject({ state: "Downloaded", received: 5, total: 10 });
  expect(controller.status()).not.toHaveProperty("attempt");
});

it("cancelled download ignores late progress/completion and serializes cleanup", async () => {
  let finish!: (value: AuthenticatedStage) => void;
  let request!: StageOptions;
  const stage = vi.fn((options: StageOptions) => {
    request = options;
    return new Promise<AuthenticatedStage>((resolve) => {
      finish = resolve;
    });
  });
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    stage,
    installationRoot: () => "managed-root",
  });
  controller.check();
  await tick();
  controller.download();
  await tick();
  controller.cancel();
  expect(request.signal.aborted).toBe(true);
  controller.check();
  controller.download();
  expect(stage).toHaveBeenCalledTimes(1);
  request.onProgress({ state: "Verified", received: 10, total: 10 });
  finish(staged);
  await tick();
  expect(controller.status().state).toBe("Idle");
  controller.check();
  await tick();
  expect(controller.status().state).toBe("Available");
});

for (const failure of ["rejection", "wrong-manifest", "wrong-version"])
  it(`download ${failure} cannot report completion`, async () => {
    const controller = new DesktopUpdateCheck({
      source: async () => source,
      discover: async () => offer,
      trustedPublicKeys: ["trusted"],
      installationRoot: () => "managed-root",
      stage: async () => {
        if (failure === "rejection") throw new Error("ENOSPC");
        return {
          ...staged,
          ...(failure === "wrong-manifest"
            ? { manifestSha256: "c".repeat(64) }
            : { version: "wrong" }),
        };
      },
    });
    controller.check();
    await tick();
    controller.download();
    await tick();
    expect(controller.status().state).toBe("Failed");
    controller.check();
    await tick();
    expect(controller.status().state).toBe("Available");
  });
it("unconfigured builds perform no source reads or network calls", () => {
  const read = vi.fn(),
    discover = vi.fn();
  const controller = new DesktopUpdateCheck({ source: read, discover, trustedPublicKeys: [] });
  expect(controller.check().state).toBe("Unavailable");
  expect(read).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
});
it("duplicate requests share one authenticated lookup and expose only display metadata", async () => {
  let complete!: (value: AvailableRelease) => void;
  const discover = vi.fn(
    () =>
      new Promise<AvailableRelease>((resolve) => {
        complete = resolve;
      }),
  );
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover,
    trustedPublicKeys: ["trusted"],
  });
  expect(controller.check().state).toBe("Checking");
  controller.check();
  await tick();
  expect(discover).toHaveBeenCalledTimes(1);
  complete(available);
  await tick();
  expect(controller.status()).toEqual({
    schemaVersion: 1,
    state: "Available",
    version: "0.1.0-beta.12",
    mandatory: false,
  });
  const copy = controller.status();
  copy.state = "Failed";
  expect(controller.status().state).toBe("Available");
});
it("cancelled results cannot overwrite a subsequent check", async () => {
  let complete!: (value: AvailableRelease) => void;
  const discover = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<AvailableRelease>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue({ state: "UpToDate" });
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover,
    trustedPublicKeys: ["trusted"],
  });
  controller.check();
  await tick();
  const signal = discover.mock.calls[0]?.[0].signal as AbortSignal;
  expect(controller.cancel().state).toBe("Idle");
  expect(signal.aborted).toBe(true);
  controller.check();
  await tick();
  expect(controller.status().state).toBe("UpToDate");
  complete(available);
  await tick();
  expect(controller.status().state).toBe("UpToDate");
});
it("cancellation while source facts load does not start discovery", async () => {
  let complete!: (value: ReleaseSource) => void;
  const discover = vi.fn();
  const controller = new DesktopUpdateCheck({
    source: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    discover,
    trustedPublicKeys: ["trusted"],
  });
  controller.check();
  controller.cancel();
  complete(source);
  await tick();
  expect(discover).not.toHaveBeenCalled();
});
it("discovery rejection permits retry and is not reported up to date", async () => {
  const discover = vi
    .fn()
    .mockRejectedValueOnce(new Error("bad signature"))
    .mockResolvedValue({ state: "UpToDate" });
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover,
    trustedPublicKeys: ["trusted"],
    recordError: () => {
      throw new Error("diagnostic failure");
    },
  });
  controller.check();
  await tick();
  expect(controller.status().state).toBe("Failed");
  controller.check();
  await tick();
  expect(controller.status().state).toBe("UpToDate");
});
it("closing Desktop aborts checks and prevents future requests", async () => {
  const discover = vi.fn();
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover,
    trustedPublicKeys: ["trusted"],
  });
  controller.check();
  controller.dispose();
  await tick();
  expect(discover).not.toHaveBeenCalled();
  expect(controller.check().state).toBe("Unavailable");
});

it("apply requires preparation, dispatches once, and shutdown cancellation permits retry", async () => {
  let finish!: (result: "Cancelled") => void;
  const apply = vi.fn(
    () =>
      new Promise<"Cancelled">((resolve) => {
        finish = resolve;
      }),
  );
  const ticket = { name: "job-ABC", sha256: "a".repeat(64) };
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    installationRoot: () => "managed-root",
    stage: async () => staged,
    prepare: async () => ticket,
    apply,
  });
  controller.apply();
  expect(apply).not.toHaveBeenCalled();
  controller.check();
  await tick();
  controller.download();
  await tick();
  await tick();
  expect(controller.apply().state).toBe("Applying");
  controller.apply();
  controller.check();
  expect(controller.cancel().state).toBe("Applying");
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith(ticket);
  finish("Cancelled");
  await tick();
  await tick();
  expect(controller.status().state).toBe("Prepared");
  controller.apply();
  expect(apply).toHaveBeenCalledTimes(2);
  finish("Cancelled");
  await tick();
});

it("failed activation is not reported as an installed update", async () => {
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    discover: async () => offer,
    trustedPublicKeys: ["trusted"],
    installationRoot: () => "managed-root",
    stage: async () => staged,
    prepare: async () => ({ name: "job-ABC", sha256: "a".repeat(64) }),
    apply: async () => {
      throw new Error("worker failed");
    },
  });
  controller.check();
  await tick();
  controller.download();
  await tick();
  await tick();
  controller.apply();
  await tick();
  await tick();
  expect(controller.status().state).toBe("Failed");
});

it("startup outcome restoration never grants apply or starts discovery", async () => {
  const discover = vi.fn(),
    apply = vi.fn();
  const restore = vi
    .fn()
    .mockResolvedValueOnce({
      schemaVersion: 1,
      state: "Unresolved",
      version: null,
      mandatory: false,
    })
    .mockResolvedValue({
      schemaVersion: 1,
      state: "Updated",
      version: "0.1.0-beta.12",
      mandatory: false,
    });
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    trustedPublicKeys: [],
    discover,
    restore,
    apply,
  });
  expect((await controller.refresh()).state).toBe("Unresolved");
  expect((await controller.refresh()).state).toBe("Updated");
  controller.apply();
  expect(apply).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
});
it("late restored status cannot overwrite a user-initiated check", async () => {
  let finish!: (value: undefined) => void;
  const controller = new DesktopUpdateCheck({
    source: async () => source,
    trustedPublicKeys: ["trusted"],
    discover: async () => offer,
    restore: () =>
      new Promise<undefined>((resolve) => {
        finish = resolve;
      }),
  });
  const pending = controller.refresh();
  controller.check();
  await tick();
  finish(undefined);
  await pending;
  expect(controller.status().state).toBe("Available");
});
