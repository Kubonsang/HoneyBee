import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  ActiveWorkspaceStorageV1Schema,
  ComponentManagerSnapshotV1Schema,
  HoneyBeeCompatibilityManifestV1Schema,
  InstalledComponentReceiptV1Schema,
  ProjectComponentLockV1Schema,
  type ActiveWorkspaceStorageV1,
  type ComponentManagerSnapshotV1,
  type ComponentPayloadV1,
  type ComponentReleaseV1,
  type HoneyBeeCompatibilityManifestV1,
  type InstalledComponentReceiptV1,
  type ManagedComponentId,
  type ProjectComponentLockV1,
} from "../shared/ipc.js";

const execFileAsync = promisify(execFile);
const MAX_COMPONENT_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const ALLOWED_DOWNLOAD_ORIGINS = new Set([
  "https://github.com",
  "https://release-assets.githubusercontent.com",
]);
export const PACKAGED_COMPATIBILITY_MANIFEST_SHA256 =
  "596ceb931956636baa1af760d6566d151bef5056eb56e9f8cbb29742f542be52";

type ComponentPayload = ComponentPayloadV1;
type Download = (url: string, target: string, maximumBytes: number) => Promise<void>;
type ExtractZip = (archive: string, destination: string) => Promise<void>;

const canonical = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digestJson = (value: unknown): string => digestBytes(Buffer.from(canonical(value), "utf8"));

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const digestFile = async (target: string): Promise<{ byteLength: number; sha256: string }> => {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Component file is not a private regular file.");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(target)) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_COMPONENT_DOWNLOAD_BYTES) throw new Error("Component file is too large.");
    hash.update(bytes);
  }
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("Component file changed while it was inspected.");
  }
  return { byteLength, sha256: hash.digest("hex") };
};

const treeEntries = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error("Component tree contains a link.");
      if (status.isDirectory()) {
        await visit(absolute);
      } else if (status.isFile() && status.nlink === 1) {
        found.push(relative);
      } else {
        throw new Error("Component tree contains an unsupported entry.");
      }
    }
  };
  await visit(root);
  return found.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
};

const digestTree = async (root: string): Promise<{ byteLength: number; sha256: string }> => {
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Component tree root is unsafe.");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for (const relative of await treeEntries(root)) {
    const file = await digestFile(path.join(root, ...relative.split("/")));
    const relativeBytes = Buffer.from(relative, "utf8");
    const frame = Buffer.allocUnsafe(8);
    frame.writeUInt32BE(relativeBytes.byteLength, 0);
    frame.writeUInt32BE(file.byteLength, 4);
    hash.update(frame);
    hash.update(relativeBytes);
    hash.update(Buffer.from(file.sha256, "hex"));
    byteLength += file.byteLength;
  }
  return { byteLength, sha256: hash.digest("hex") };
};

const ensurePrivateDirectory = async (target: string): Promise<void> => {
  await mkdir(target, { recursive: true });
  const status = await lstat(target);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Component directory is unsafe.");
  }
};

const ensurePrivateDirectoryChain = async (
  baseValue: string,
  targetValue: string,
): Promise<void> => {
  const base = path.resolve(baseValue);
  const target = path.resolve(targetValue);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Component directory escaped its managed root.");
  }
  await ensurePrivateDirectory(base);
  let current = base;
  for (const segment of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Component directory chain contains a link.");
    }
  }
};

const assertPrivateDirectoryChain = async (
  baseValue: string,
  targetValue: string,
): Promise<void> => {
  const base = path.resolve(baseValue);
  const target = path.resolve(targetValue);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Component directory escaped its managed root.");
  }
  let current = base;
  for (const segment of ["", ...relative.split(path.sep).filter((value) => value.length > 0)]) {
    if (segment.length > 0) current = path.join(current, segment);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Component directory chain contains a link.");
    }
  }
};

const publishExclusiveJson = async (target: string, value: unknown): Promise<void> => {
  const handle = await open(target, "wx");
  try {
    await handle.writeFile(Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const replaceJson = async (target: string, value: unknown): Promise<void> => {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    "." + path.basename(target) + "." + randomUUID(),
  );
  await publishExclusiveJson(temporary, value);
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const defaultDownload: Download = async (urlValue, target, maximumBytes) => {
  let current = new URL(urlValue);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!ALLOWED_DOWNLOAD_ORIGINS.has(current.origin)) {
      throw new Error("Component download escaped the approved GitHub origins.");
    }
    const response = await fetch(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error("Component download redirect is invalid.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || response.body === null) throw new Error("Component download failed.");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new Error("Component download exceeds its size limit.");
    }
    const handle = await open(target, "wx");
    let written = 0;
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        written += bytes.byteLength;
        if (written > maximumBytes) throw new Error("Component download exceeds its size limit.");
        await handle.write(bytes);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  throw new Error("Component download redirected too many times.");
};

const defaultExtractZip: ExtractZip = async (archive, destination) => {
  await execFileAsync("tar", ["-xf", archive, "-C", destination], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
};

const findEntry = async (root: string, expectedName: string): Promise<string> => {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error("Component archive contains a link.");
      if (entry.name === expectedName) matches.push(absolute);
      if (status.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  if (matches.length !== 1) throw new Error("Component archive entry is missing or ambiguous.");
  return matches[0] as string;
};

const standardizedName = (
  componentId: ManagedComponentId,
  role: ComponentPayload["role"],
): string => {
  if (componentId === "workspace-storage") {
    return role === "client"
      ? "unity-workspace-storage.exe"
      : "honeybee-workspace-storage-host.exe";
  }
  return role === "cli" ? "testplay.exe" : "com.testplay.bridge";
};

export class DesktopComponentManager {
  readonly #root: string;
  readonly #receiptsRoot: string;
  readonly #activePath: string;
  readonly #manifest: HoneyBeeCompatibilityManifestV1;
  readonly #manifestDigest: string;

  public constructor(
    rootValue: string,
    private readonly bundledToolsRoot: string,
    manifestValue: unknown,
    private readonly download: Download = defaultDownload,
    private readonly extractZip: ExtractZip = defaultExtractZip,
    private readonly activeServiceExecutable?: string,
  ) {
    this.#root = path.resolve(rootValue);
    this.#receiptsRoot = path.join(this.#root, "installed");
    this.#activePath = path.join(this.#root, "active-workspace-storage.json");
    this.#manifest = HoneyBeeCompatibilityManifestV1Schema.parse(manifestValue);
    this.#manifestDigest = digestJson(this.#manifest);
  }

  public get manifestDigest(): string {
    return this.#manifestDigest;
  }

  public releases(componentId: ManagedComponentId): readonly ComponentReleaseV1[] {
    return componentId === "workspace-storage"
      ? this.#manifest.workspaceStorage
      : this.#manifest.testplay;
  }

  public async ensureBundledWorkspaceStorage(): Promise<InstalledComponentReceiptV1> {
    const release = this.#manifest.workspaceStorage[0];
    if (release === undefined) throw new Error("No bundled workspace-storage release is approved.");
    return this.#install(release);
  }

  public async installWorkspaceStorage(version: string): Promise<InstalledComponentReceiptV1> {
    const release = this.#manifest.workspaceStorage.find(
      (candidate) => candidate.version === version,
    );
    if (release === undefined) {
      throw new Error("That workspace-storage version is not bundled with this HoneyBee build.");
    }
    return this.#install(release);
  }

  public async installTestPlay(
    version: string,
    approved: boolean,
  ): Promise<InstalledComponentReceiptV1> {
    if (!approved) throw new Error("TestPlay installation requires explicit approval.");
    const release = this.#manifest.testplay.find((candidate) => candidate.version === version);
    if (release === undefined) {
      throw new Error("That TestPlay version is not approved by this HoneyBee build.");
    }
    return this.#install(release);
  }

  public async receipt(
    componentId: ManagedComponentId,
    version: string,
  ): Promise<InstalledComponentReceiptV1> {
    const target = this.#receiptPath(componentId, version);
    await assertPrivateDirectoryChain(this.#root, path.dirname(target));
    const status = await lstat(target);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size > 64 * 1024
    ) {
      throw new Error("Installed component receipt is unsafe.");
    }
    const receipt = InstalledComponentReceiptV1Schema.parse(
      JSON.parse(await readFile(target, "utf8")),
    );
    await this.#verifyReceipt(receipt);
    return receipt;
  }

  public async lock(
    componentId: ManagedComponentId,
    version: string,
  ): Promise<ProjectComponentLockV1> {
    const receipt = await this.receipt(componentId, version);
    return ProjectComponentLockV1Schema.parse({
      schemaVersion: 1,
      componentId,
      version,
      receiptDigest: digestJson(receipt),
      files: receipt.files,
    });
  }

  public async activateWorkspaceStorage(
    version: string,
    workspaceRootValue: string,
  ): Promise<ActiveWorkspaceStorageV1> {
    const lock = await this.lock("workspace-storage", version);
    await this.#assertActiveServiceExecutable(lock);
    const active = ActiveWorkspaceStorageV1Schema.parse({
      schemaVersion: 1,
      version,
      receiptDigest: lock.receiptDigest,
      workspaceRoot: path.resolve(workspaceRootValue),
      activatedAt: new Date().toISOString(),
    });
    await replaceJson(this.#activePath, active);
    return active;
  }

  public async assertWorkspaceStorageActive(lockValue: ProjectComponentLockV1): Promise<void> {
    const lock = ProjectComponentLockV1Schema.parse(lockValue);
    if (lock.componentId !== "workspace-storage") throw new Error("Storage lock has the wrong ID.");
    const verified = await this.lock("workspace-storage", lock.version);
    if (canonical(verified) !== canonical(lock)) throw new Error("Storage component lock changed.");
    await this.#assertActiveServiceExecutable(lock);
    let active: ActiveWorkspaceStorageV1;
    try {
      active = ActiveWorkspaceStorageV1Schema.parse(
        JSON.parse(await readFile(this.#activePath, "utf8")),
      );
    } catch {
      throw new Error("No machine-global workspace-storage version is active.");
    }
    if (active.version !== lock.version || active.receiptDigest !== lock.receiptDigest) {
      throw new Error(
        "The project storage lock differs from the machine-global active version. Switch it explicitly.",
      );
    }
  }

  public async assertLock(lockValue: ProjectComponentLockV1): Promise<void> {
    const lock = ProjectComponentLockV1Schema.parse(lockValue);
    const verified = await this.lock(lock.componentId, lock.version);
    if (canonical(verified) !== canonical(lock)) {
      throw new Error("The project component lock no longer matches its installed receipt.");
    }
  }

  public async snapshot(): Promise<ComponentManagerSnapshotV1> {
    const installed: InstalledComponentReceiptV1[] = [];
    for (const componentId of ["workspace-storage", "testplay"] as const) {
      const root = path.join(this.#receiptsRoot, componentId);
      let versions: string[];
      try {
        versions = await readdir(root);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      for (const version of versions) {
        try {
          installed.push(await this.receipt(componentId, version));
        } catch {
          // An invalid receipt is intentionally excluded and will fail any direct lock lookup.
        }
      }
    }
    let activeWorkspaceStorage: ActiveWorkspaceStorageV1 | undefined;
    try {
      activeWorkspaceStorage = ActiveWorkspaceStorageV1Schema.parse(
        JSON.parse(await readFile(this.#activePath, "utf8")),
      );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") activeWorkspaceStorage = undefined;
    }
    return ComponentManagerSnapshotV1Schema.parse({
      schemaVersion: 1,
      manifestDigest: this.#manifestDigest,
      releases: [...this.#manifest.workspaceStorage, ...this.#manifest.testplay],
      installed,
      ...(activeWorkspaceStorage === undefined ? {} : { activeWorkspaceStorage }),
    });
  }

  async #install(release: ComponentReleaseV1): Promise<InstalledComponentReceiptV1> {
    try {
      return await this.receipt(release.componentId, release.version);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        const receiptTarget = this.#receiptPath(release.componentId, release.version);
        if (
          await stat(receiptTarget)
            .then(() => true)
            .catch(() => false)
        )
          throw error;
      }
    }
    await ensurePrivateDirectoryChain(this.#root, this.#receiptsRoot);
    const staging = await mkdtemp(path.join(this.#receiptsRoot, ".component-"));
    try {
      const files: Array<InstalledComponentReceiptV1["files"][number]> = [];
      for (const payload of release.payloads) {
        if (path.basename(payload.fileName) !== payload.fileName) {
          throw new Error("Component payload name is unsafe.");
        }
        const source =
          payload.source === "bundled"
            ? path.join(this.bundledToolsRoot, payload.fileName)
            : await this.#download(payload, staging);
        const observed = await digestFile(source);
        if (observed.byteLength !== payload.byteLength || observed.sha256 !== payload.sha256) {
          throw new Error("Component payload does not match the fixed compatibility manifest.");
        }
        const installedName = standardizedName(release.componentId, payload.role);
        const target = path.join(staging, installedName);
        if (payload.archive === "none") {
          await copyFile(source, target);
          const copied = await digestFile(target);
          if (canonical(copied) !== canonical(observed)) throw new Error("Component copy changed.");
          files.push({ role: payload.role, path: target, kind: "file", ...copied });
        } else {
          const extracted = path.join(staging, ".extract-" + payload.role);
          await ensurePrivateDirectory(extracted);
          await this.extractZip(source, extracted);
          const expected =
            payload.role === "bridge-overlay" ? "com.testplay.bridge" : "testplay.exe";
          const entry = await findEntry(extracted, expected);
          if (payload.role === "bridge-overlay") {
            await cp(entry, target, { recursive: true, errorOnExist: true, force: false });
            files.push({
              role: payload.role,
              path: target,
              kind: "tree",
              ...(await digestTree(target)),
            });
          } else {
            await copyFile(entry, target);
            files.push({
              role: payload.role,
              path: target,
              kind: "file",
              ...(await digestFile(target)),
            });
          }
          await rm(extracted, { recursive: true, force: true });
        }
      }
      if (release.componentId === "testplay") {
        const bridge = files.find((file) => file.role === "bridge-overlay");
        if (bridge?.kind !== "tree" || bridge.sha256 !== release.bridgeOverlayDigest) {
          throw new Error("Installed Bridge overlay does not match its approved release digest.");
        }
      }
      const finalRoot = path.join(this.#receiptsRoot, release.componentId, release.version);
      await ensurePrivateDirectoryChain(this.#root, path.dirname(finalRoot));
      const installedAt = new Date().toISOString();
      const receipt = InstalledComponentReceiptV1Schema.parse({
        schemaVersion: 1,
        componentId: release.componentId,
        version: release.version,
        manifestDigest: this.#manifestDigest,
        installedAt,
        files: files.map((file) => ({
          ...file,
          path: path.join(finalRoot, path.basename(file.path)),
        })),
      });
      await publishExclusiveJson(path.join(staging, "receipt.json"), receipt);
      try {
        await rename(staging, finalRoot);
      } catch (error) {
        if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
        return this.receipt(release.componentId, release.version);
      }
      await this.#verifyReceipt(receipt);
      return receipt;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #download(payload: ComponentPayload, staging: string): Promise<string> {
    if (payload.url === undefined) throw new Error("Downloaded component has no fixed URL.");
    const target = path.join(staging, "." + payload.role + "-" + randomUUID() + ".download");
    await this.download(
      payload.url,
      target,
      Math.min(payload.byteLength, MAX_COMPONENT_DOWNLOAD_BYTES),
    );
    return target;
  }

  async #verifyReceipt(receipt: InstalledComponentReceiptV1): Promise<void> {
    if (receipt.manifestDigest !== this.#manifestDigest) {
      throw new Error("Installed component belongs to a different compatibility manifest.");
    }
    const release = this.releases(receipt.componentId).find(
      (candidate) => candidate.version === receipt.version,
    );
    if (release === undefined)
      throw new Error("Installed component version is no longer approved.");
    const expectedRoles = new Set(release.payloads.map((payload) => payload.role));
    const observedRoles = new Set(receipt.files.map((file) => file.role));
    if (
      receipt.files.length !== expectedRoles.size ||
      observedRoles.size !== expectedRoles.size ||
      [...expectedRoles].some((role) => !observedRoles.has(role))
    ) {
      throw new Error("Installed component receipt has an invalid payload set.");
    }
    const expectedRoot = path.join(this.#receiptsRoot, receipt.componentId, receipt.version);
    for (const file of receipt.files) {
      const resolved = path.resolve(file.path);
      const relative = path.relative(expectedRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Installed component escaped its version directory.");
      }
      const observed =
        file.kind === "file" ? await digestFile(resolved) : await digestTree(resolved);
      if (observed.byteLength !== file.byteLength || observed.sha256 !== file.sha256) {
        throw new Error("Installed component integrity check failed.");
      }
      const payload = release.payloads.find((candidate) => candidate.role === file.role);
      if (payload === undefined) throw new Error("Installed component payload is not approved.");
      if (file.role === "bridge-overlay") {
        if (file.kind !== "tree" || file.sha256 !== release.bridgeOverlayDigest) {
          throw new Error(
            "Installed Bridge overlay differs from the fixed compatibility manifest.",
          );
        }
      } else if (
        file.kind !== "file" ||
        file.byteLength !== payload.byteLength ||
        file.sha256 !== payload.sha256
      ) {
        throw new Error("Installed component differs from the fixed compatibility manifest.");
      }
    }
  }

  async #assertActiveServiceExecutable(lock: ProjectComponentLockV1): Promise<void> {
    if (this.activeServiceExecutable === undefined) {
      throw new Error("The machine-global workspace-storage service path is unavailable.");
    }
    const hosts = lock.files.filter((file) => file.role === "host");
    if (hosts.length !== 1) throw new Error("Storage lock has no unique host executable.");
    const expected = hosts[0] as ProjectComponentLockV1["files"][number];
    const observed = await digestFile(path.resolve(this.activeServiceExecutable));
    if (
      expected.kind !== "file" ||
      observed.byteLength !== expected.byteLength ||
      observed.sha256 !== expected.sha256
    ) {
      throw new Error(
        "The machine-global workspace-storage service differs from the project lock. Switch it explicitly.",
      );
    }
  }

  #receiptPath(componentId: ManagedComponentId, version: string): string {
    if (!/^[0-9A-Za-z.+-]{1,128}$/u.test(version)) throw new Error("Invalid component version.");
    return path.join(this.#receiptsRoot, componentId, version, "receipt.json");
  }
}

export const readCompatibilityManifest = async (
  target: string,
  expectedDigest = PACKAGED_COMPATIBILITY_MANIFEST_SHA256,
): Promise<HoneyBeeCompatibilityManifestV1> =>
  readFile(target).then((bytes) => {
    if (digestBytes(bytes) !== expectedDigest) {
      throw new Error("Packaged compatibility manifest integrity check failed.");
    }
    return HoneyBeeCompatibilityManifestV1Schema.parse(JSON.parse(bytes.toString("utf8")));
  });
