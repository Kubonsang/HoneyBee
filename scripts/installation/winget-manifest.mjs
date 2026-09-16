import assert from "node:assert/strict";
import { compareVersions, validateDownloadUrl } from "../update/release-manifest.mjs";

/** Local qualification manifest, not an external submission. Until Setup upgrade
 * composition is implemented, WinGet must not attempt reinstall/uninstall upgrades. */
export function renderWingetManifest({ version, setupUrl, setupSha256 }) {
  compareVersions(version, "0.0.0");
  validateDownloadUrl(setupUrl);
  assert(/^[a-f0-9]{64}$/u.test(setupSha256));
  const q = JSON.stringify;
  return [
    "# yaml-language-server: $schema=https://aka.ms/winget-manifest.singleton.1.6.0.schema.json",
    "PackageIdentifier: Kubonsang.HoneyBee",
    `PackageVersion: ${q(version)}`,
    "PackageLocale: en-US",
    "Publisher: Kubonsang",
    "PackageName: HoneyBee",
    "License: MIT",
    "ShortDescription: Unity workspace management for Windows.",
    "PackageUrl: https://github.com/Kubonsang/HoneyBee",
    "InstallerType: nullsoft",
    "Scope: user",
    "MinimumOSVersion: 10.0.22000.0",
    "InstallModes:",
    "  - interactive",
    "UpgradeBehavior: deny",
    "Dependencies:",
    "  PackageDependencies:",
    "    - PackageIdentifier: Git.Git",
    "Installers:",
    "  - Architecture: x64",
    `    InstallerUrl: ${q(setupUrl)}`,
    `    InstallerSha256: ${setupSha256.toUpperCase()}`,
    "ExpectedReturnCodes:",
    "  - InstallerReturnCode: 2",
    "    ReturnResponse: contactSupport",
    "  - InstallerReturnCode: 3",
    "    ReturnResponse: missingDependency",
    "ManifestType: singleton",
    "ManifestVersion: 1.6.0",
    "",
  ].join("\n");
}
