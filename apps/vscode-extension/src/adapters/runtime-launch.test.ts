import path from "node:path";

import { describe, expect, it } from "vitest";

import { packagedRuntimePath, resolveRuntimeLaunch } from "./runtime-launch.js";

describe("runtime launch resolution", () => {
  it("uses the absolute runtime bundled inside the extension by default", () => {
    const extensionRoot = path.resolve("C:/Honey Bee/extensions/honeybee");

    expect(
      resolveRuntimeLaunch({
        extensionRoot,
        configuredCommand: "node",
        configuredArgs: [],
        usePackagedDefault: true,
      }),
    ).toEqual({
      command: "node",
      args: [path.join(extensionRoot, "dist", "runtime", "cli.cjs")],
    });
    expect(path.isAbsolute(packagedRuntimePath(extensionRoot))).toBe(true);
  });

  it("preserves an explicit command and argv without rewriting or shell joining", () => {
    const configuredArgs = ['literal "quote" & | ^ %PATH%', "C:\\한글 경로\\runtime.js"];

    const launch = resolveRuntimeLaunch({
      extensionRoot: "C:\\extension",
      configuredCommand: "C:\\Program Files\\Runtime\\runtime.exe",
      configuredArgs,
      usePackagedDefault: false,
    });

    expect(launch).toEqual({
      command: "C:\\Program Files\\Runtime\\runtime.exe",
      args: configuredArgs,
    });
    expect(launch.args).not.toBe(configuredArgs);
  });
});
