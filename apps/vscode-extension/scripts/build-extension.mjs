import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });
await Promise.all([
  mkdir("dist/webview", { recursive: true }),
  mkdir("dist/runtime/node_modules/node-pty", { recursive: true }),
  mkdir("dist/licenses", { recursive: true }),
]);

const excludeDebugSymbols = (source) => !source.toLowerCase().endsWith(".pdb");

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: ["node20"],
    sourcemap: true,
    legalComments: "linked",
    logLevel: "info",
  }),
  build({
    entryPoints: ["../../packages/session-runtime/src/cli.ts"],
    outfile: "dist/runtime/cli.cjs",
    bundle: true,
    external: ["node-pty"],
    format: "cjs",
    platform: "node",
    target: ["node20"],
    sourcemap: true,
    legalComments: "linked",
    logLevel: "info",
  }),
]);

await Promise.all([
  cp("../../packages/ui-shared/dist/webview/console.js", "dist/webview/console.js"),
  cp("../../packages/ui-shared/dist/webview/console.js.map", "dist/webview/console.js.map"),
  cp("../../packages/ui-shared/dist/webview/console.css", "dist/webview/console.css"),
  cp(
    "../../packages/session-runtime/node_modules/node-pty/lib",
    "dist/runtime/node_modules/node-pty/lib",
    { recursive: true, filter: excludeDebugSymbols },
  ),
  cp(
    "../../packages/session-runtime/node_modules/node-pty/prebuilds/win32-x64",
    "dist/runtime/node_modules/node-pty/prebuilds/win32-x64",
    { recursive: true, filter: excludeDebugSymbols },
  ),
  cp(
    "../../packages/session-runtime/node_modules/node-pty/prebuilds/win32-arm64",
    "dist/runtime/node_modules/node-pty/prebuilds/win32-arm64",
    { recursive: true, filter: excludeDebugSymbols },
  ),
  cp(
    "../../packages/session-runtime/node_modules/node-pty/package.json",
    "dist/runtime/node_modules/node-pty/package.json",
  ),
  cp(
    "../../packages/session-runtime/node_modules/node-pty/LICENSE",
    "dist/runtime/node_modules/node-pty/LICENSE",
  ),
  cp("../../LICENSE", "dist/LICENSE"),
  cp("../../THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md"),
  cp("../../packages/domain/node_modules/zod/LICENSE", "dist/licenses/zod-LICENSE"),
  cp("../../packages/ui-shared/node_modules/@xterm/xterm/LICENSE", "dist/licenses/xterm-LICENSE"),
  cp(
    "../../packages/ui-shared/node_modules/@xterm/addon-fit/LICENSE",
    "dist/licenses/xterm-addon-fit-LICENSE",
  ),
  cp(
    "../../packages/ui-shared/node_modules/monaco-editor/LICENSE",
    "dist/licenses/monaco-editor-LICENSE",
  ),
  cp(
    "../../packages/session-runtime/node_modules/node-pty/LICENSE",
    "dist/licenses/node-pty-LICENSE",
  ),
]);
