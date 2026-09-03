import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceRegistryStore } from "./workspace-registry.js";
import type {
  DoctorCheckV1,
  DoctorReportV1,
  WorkspaceRecordV2,
  WorkspaceStoragePort,
  WorkspaceViewV1,
} from "./workspace-types.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceDoctorOptions {
  readonly storageCommand?: string;
  readonly expectedComponentVersion?: string;
  readonly expectedClientSha256?: string;
  readonly expectedControlSha256?: string;
}

const digest = async (target: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(target))
    .digest("hex");

const exists = async (target: string): Promise<boolean> =>
  lstat(target)
    .then(() => true)
    .catch(() => false);

const check = (
  code: string,
  status: DoctorCheckV1["status"],
  message: string,
  options: Pick<DoctorCheckV1, "subject" | "remediation"> = {},
): DoctorCheckV1 => ({ code, status, message, ...options });

export const runWorkspaceDoctor = async (
  registry: WorkspaceRegistryStore,
  storage: WorkspaceStoragePort,
  options: WorkspaceDoctorOptions,
  viewWorkspace: (record: WorkspaceRecordV2) => Promise<WorkspaceViewV1>,
): Promise<DoctorReportV1> => {
  const checks: DoctorCheckV1[] = [];
  const release = os.release();
  const build = Number(release.split(".")[2] ?? 0);
  checks.push(
    process.platform === "win32" && process.arch === "x64" && build >= 22_000
      ? check("system.windows", "pass", `Windows 11 x64 (${release}) is supported.`)
      : check(
          "system.windows",
          "fail",
          `HoneyBee requires Windows 11 x64; detected ${process.platform}/${process.arch} ${release}.`,
        ),
  );
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 24
      ? check("runtime.node", "pass", `Node.js ${process.versions.node} is supported.`)
      : check("runtime.node", "fail", "HoneyBee CLI requires Node.js 24 or newer.", {
          remediation: ["Install Node.js 24, then run honeybee doctor again."],
        }),
  );
  try {
    const result = await execFileAsync("git.exe", ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    checks.push(check("git.executable", "pass", result.stdout.trim()));
  } catch {
    checks.push(
      check("git.executable", "fail", "git.exe is not installed or cannot run.", {
        remediation: ["Install Git for Windows and ensure git.exe is on PATH."],
      }),
    );
  }

  let value;
  try {
    value = await registry.read();
    checks.push(
      check("registry.read", "pass", `Workspace registry is readable at ${registry.path}.`),
    );
  } catch (error) {
    checks.push(
      check(
        "registry.read",
        "fail",
        error instanceof Error ? error.message : "Workspace registry could not be read.",
      ),
    );
    return report(checks);
  }

  const storageCommand = options.storageCommand ?? value.projects[0]?.storageCommand;
  let controlCommand: string | undefined;
  if (storageCommand === undefined) {
    checks.push(
      check("storage.command", "fail", "The packaged workspace-storage executable was not found.", {
        remediation: ["Extract the complete HoneyBee CLI ZIP and run honeybee doctor again."],
      }),
    );
  } else {
    controlCommand =
      process.env.HONEYBEE_WORKSPACE_STORAGE_CONTROL ??
      path.join(path.dirname(storageCommand), "honeybee-workspace-storage-host.exe");
    const clientExists = await exists(storageCommand);
    checks.push(
      clientExists
        ? check("storage.command", "pass", "workspace-storage executable is present.")
        : check(
            "storage.command",
            "fail",
            `workspace-storage executable is missing: ${storageCommand}`,
          ),
    );
    const controlExists = await exists(controlCommand);
    checks.push(
      controlExists
        ? check("storage.control-command", "pass", "Storage control companion is present.")
        : check(
            "storage.control-command",
            "fail",
            `Storage control companion is missing: ${controlCommand}`,
          ),
    );
    if (
      clientExists &&
      controlExists &&
      options.expectedClientSha256 !== undefined &&
      options.expectedControlSha256 !== undefined
    ) {
      const [clientDigest, controlDigest] = await Promise.all([
        digest(storageCommand),
        digest(controlCommand),
      ]);
      checks.push(
        clientDigest === options.expectedClientSha256 &&
          controlDigest === options.expectedControlSha256
          ? check(
              "storage.package-integrity",
              "pass",
              "Bundled storage tools match their manifest.",
            )
          : check(
              "storage.package-integrity",
              "fail",
              "Bundled storage tools do not match their package manifest.",
              { remediation: ["Download and extract a fresh HoneyBee CLI archive."] },
            ),
      );
    } else {
      checks.push(
        check(
          "storage.package-integrity",
          "warning",
          "No package manifest was available to verify storage tool hashes.",
        ),
      );
    }
  }

  if (
    storageCommand !== undefined &&
    controlCommand !== undefined &&
    storage.diagnose !== undefined
  ) {
    try {
      const diagnostic = await storage.diagnose(storageCommand);
      checks.push(
        diagnostic.serviceExists && diagnostic.serviceState === "running"
          ? check("storage.service", "pass", "UnityWorkspaceStorage service is running.")
          : check(
              "storage.service",
              "fail",
              diagnostic.serviceExists
                ? `UnityWorkspaceStorage service is ${diagnostic.serviceState ?? "unavailable"}.`
                : "UnityWorkspaceStorage service is not installed.",
              { remediation: ["Follow the documented elevated storage installation procedure."] },
            ),
      );
      const receiptMatches =
        diagnostic.receiptExists &&
        diagnostic.receiptValid &&
        diagnostic.executableExists &&
        diagnostic.executableDigestMatches &&
        diagnostic.userMatches &&
        (options.expectedComponentVersion === undefined ||
          diagnostic.componentVersion === options.expectedComponentVersion);
      checks.push(
        receiptMatches
          ? check("storage.install-receipt", "pass", "Storage install receipt is valid.")
          : check(
              "storage.install-receipt",
              "fail",
              "Storage install receipt is missing, invalid, or belongs to a different package/user.",
              {
                remediation: [
                  "Run the documented storage install command with --replace if required.",
                ],
              },
            ),
      );
      checks.push(
        diagnostic.workspaceRootAccessible
          ? check(
              "storage.workspace-root",
              "pass",
              "Storage workspace root is accessible.",
              diagnostic.workspaceRoot === undefined ? {} : { subject: diagnostic.workspaceRoot },
            )
          : check("storage.workspace-root", "fail", "Storage workspace root is not accessible."),
      );
      if (
        diagnostic.serviceExists &&
        diagnostic.serviceState === "running" &&
        storage.status !== undefined
      ) {
        try {
          const status = await storage.status(storageCommand);
          checks.push(
            status.manualRecoveryRequired
              ? check(
                  "storage.status",
                  "fail",
                  "Workspace storage reports that manual recovery is required.",
                )
              : check(
                  "storage.status",
                  "pass",
                  `Workspace storage is responsive with ${status.parentCount} parent(s).`,
                ),
          );
        } catch (error) {
          checks.push(
            check(
              "storage.status",
              "fail",
              error instanceof Error ? error.message : "Workspace storage did not respond.",
            ),
          );
        }
      }
    } catch (error) {
      checks.push(
        check(
          "storage.diagnostic",
          "fail",
          error instanceof Error ? error.message : "Storage diagnostics failed.",
        ),
      );
    }
  }

  checks.push(
    value.projects.length === 0
      ? check("projects.registered", "warning", "No Unity project is registered.")
      : check(
          "projects.registered",
          "pass",
          `${value.projects.length} Unity project(s) registered.`,
        ),
  );
  for (const project of value.projects) {
    const subject = `${project.label} (${project.projectId})`;
    const projectControl =
      process.env.HONEYBEE_WORKSPACE_STORAGE_CONTROL ??
      path.join(path.dirname(project.storageCommand), "honeybee-workspace-storage-host.exe");
    const [projectClientExists, projectControlExists] = await Promise.all([
      exists(project.storageCommand),
      exists(projectControl),
    ]);
    let projectToolsMatch = projectClientExists && projectControlExists;
    if (
      projectToolsMatch &&
      options.expectedClientSha256 !== undefined &&
      options.expectedControlSha256 !== undefined
    ) {
      const [clientDigest, controlDigest] = await Promise.all([
        digest(project.storageCommand),
        digest(projectControl),
      ]);
      projectToolsMatch =
        clientDigest === options.expectedClientSha256 &&
        controlDigest === options.expectedControlSha256;
    }
    checks.push(
      projectToolsMatch
        ? check("project.storage-tools", "pass", "Registered storage tools are available.", {
            subject,
          })
        : check(
            "project.storage-tools",
            "fail",
            "Registered storage tools are missing or differ from this HoneyBee package.",
            {
              subject,
              remediation: [
                "Run project init again with the storage executable from this HoneyBee package.",
              ],
            },
          ),
    );
    const directories = await Promise.all(
      ["Assets", "Packages", "ProjectSettings"].map((entry) =>
        stat(path.join(project.unityProjectPath, entry))
          .then((info) => info.isDirectory())
          .catch(() => false),
      ),
    );
    checks.push(
      directories.every(Boolean)
        ? check("project.unity-layout", "pass", "Unity project layout is valid.", { subject })
        : check(
            "project.unity-layout",
            "fail",
            "Assets, Packages, or ProjectSettings is missing.",
            {
              subject,
            },
          ),
    );
    try {
      await access(project.workspaceRoot, constants.R_OK | constants.W_OK);
      checks.push(
        check("project.workspace-root", "pass", "Git Workspace root is accessible.", { subject }),
      );
    } catch {
      checks.push(
        check("project.workspace-root", "fail", "Git Workspace root is not accessible.", {
          subject,
        }),
      );
    }
    const library = path.join(project.unityProjectPath, "Library");
    const libraryPresent = await stat(library)
      .then((info) => info.isDirectory())
      .catch(() => false);
    checks.push(
      libraryPresent
        ? check("cache.source-library", "pass", "Source Library is present.", { subject })
        : check("cache.source-library", "warning", "Source Library has not been generated.", {
            subject,
          }),
    );
    if (libraryPresent) {
      try {
        await execFileAsync(
          "git.exe",
          [
            "-c",
            `safe.directory=${project.repositoryRoot.replaceAll("\\", "/")}`,
            "check-ignore",
            "--quiet",
            "--",
            path.relative(project.repositoryRoot, library),
          ],
          { cwd: project.repositoryRoot, timeout: 15_000, windowsHide: true },
        );
        checks.push(
          check("cache.library-ignored", "pass", "Source Library is ignored by Git.", { subject }),
        );
      } catch {
        checks.push(
          check("cache.library-ignored", "warning", "Source Library is not ignored by Git.", {
            subject,
          }),
        );
      }
    }
    checks.push(
      project.cache === undefined
        ? check("cache.prepared", "warning", "Library parent cache is not prepared.", { subject })
        : check("cache.prepared", "pass", "Library parent cache is registered.", { subject }),
    );
  }

  for (const workspace of value.workspaces) {
    const viewed = await viewWorkspace(workspace);
    const subject = `${workspace.name} (${workspace.workspaceId})`;
    const failing =
      viewed.state === "repair-required" || viewed.state === "cleanup-pending" || !viewed.available;
    checks.push(
      failing
        ? check(
            `workspace.${viewed.state}`,
            "fail",
            `Workspace requires attention: ${viewed.state}.`,
            {
              subject,
              remediation: [
                viewed.state === "cleanup-pending"
                  ? `Run honeybee workspace remove "${workspace.name}" again.`
                  : `Run honeybee workspace repair "${workspace.name}".`,
              ],
            },
          )
        : check("workspace.ready", "pass", "Workspace is ready.", { subject }),
    );
  }
  if (value.workspaces.length > 0) {
    checks.push(
      check(
        "workspace.reboot-repair",
        "warning",
        "Automatic repair after reboot is not released; remove Workspaces before a planned reboot.",
      ),
    );
  }
  return report(checks);
};

const report = (checks: readonly DoctorCheckV1[]): DoctorReportV1 => {
  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warning: checks.filter((item) => item.status === "warning").length,
    fail: checks.filter((item) => item.status === "fail").length,
  };
  return { schemaVersion: 1, ready: summary.fail === 0, summary, checks };
};
