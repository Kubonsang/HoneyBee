import { defineConfig } from "vitest/config";

const serializeWindowsCiFiles = process.platform === "win32" && process.env.CI === "true";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    environment: "node",
    exclude: ["**/dist/**", "**/node_modules/**", "**/.vscode-test/**"],
    // Several suites exercise real process trees and PowerShell-based process
    // identities. Isolate files on constrained Windows CI runners so one suite
    // cannot exhaust another suite's durable registration deadline.
    fileParallelism: !serializeWindowsCiFiles,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
