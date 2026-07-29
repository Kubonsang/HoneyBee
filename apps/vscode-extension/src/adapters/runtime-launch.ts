import path from "node:path";

export interface RuntimeLaunchOptions {
  readonly extensionRoot: string;
  readonly configuredCommand: string;
  readonly configuredArgs: readonly string[];
  readonly usePackagedDefault: boolean;
}

export interface RuntimeLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export const packagedRuntimePath = (extensionRoot: string): string =>
  path.resolve(extensionRoot, "dist", "runtime", "cli.cjs");

export const resolveRuntimeLaunch = (options: RuntimeLaunchOptions): RuntimeLaunch =>
  options.usePackagedDefault
    ? {
        command: "node",
        args: [packagedRuntimePath(options.extensionRoot)],
      }
    : {
        command: options.configuredCommand,
        args: [...options.configuredArgs],
      };
