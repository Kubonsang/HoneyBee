import { build } from "esbuild";

await build({
  entryPoints: ["src/webview/console.ts"],
  outfile: "dist/webview/console.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
