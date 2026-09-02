/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "core-does-not-depend-on-presentation",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    exclude: {
      path: "(^|/)(node_modules|dist|\\.vscode-test|coverage|\\.honeybee)(/|$)",
    },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(apps|packages)",
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "require", "node", "default"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
