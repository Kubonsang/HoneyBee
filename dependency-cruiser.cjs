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
      name: "domain-is-framework-free",
      severity: "error",
      from: { path: "^packages/domain/" },
      to: {
        path: "^(apps/|packages/(session-runtime|agent-adapters|persistence|workspace|tool-profiles|ui-shared)/)",
      },
    },
    {
      name: "contracts-do-not-depend-on-implementations",
      severity: "error",
      from: { path: "^packages/event-contracts/" },
      to: {
        path: "^(apps/|packages/(session-runtime|agent-adapters|persistence|workspace|tool-profiles|ui-shared)/)",
      },
    },
    {
      name: "runtime-does-not-depend-on-ui-or-extension",
      severity: "error",
      from: { path: "^packages/session-runtime/" },
      to: { path: "^(apps/|packages/ui-shared/)" },
    },
    {
      name: "ui-shared-does-not-depend-on-implementations",
      severity: "error",
      from: { path: "^packages/ui-shared/" },
      to: {
        path: "^(apps/|packages/(session-runtime|agent-adapters|persistence|workspace|tool-profiles)/)",
      },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/" },
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
