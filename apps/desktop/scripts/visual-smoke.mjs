import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { app, BrowserWindow } from "electron";

app.disableHardwareAcceleration();

const targetUrl = process.env.HONEYBEE_DESKTOP_VISUAL_URL;
const outputValue = process.env.HONEYBEE_DESKTOP_VISUAL_CAPTURE;
const validUrl =
  targetUrl !== undefined &&
  /^http:\/\/(?:127\.0\.0\.1|localhost):4173\/visual-qa\.html$/u.test(targetUrl);

const fail = (error) => {
  process.stderr.write(
    `HoneyBee Desktop visual smoke failed.\n${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  app.exit(1);
};

if (!validUrl || outputValue === undefined) {
  fail(new Error("Visual smoke requires a local visual-qa URL and capture path."));
} else {
  const outputPath = path.resolve(outputValue);
  const relative = path.relative(path.resolve(tmpdir()), outputPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(new Error("Visual smoke capture must stay inside the OS temporary directory."));
  } else {
    app
      .whenReady()
      .then(async () => {
        const consoleErrors = [];
        const window = new BrowserWindow({
          width: 1440,
          height: 1024,
          useContentSize: true,
          show: false,
          backgroundColor: "#090d10",
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        window.webContents.on("console-message", (event) => {
          if (event.level === "error") consoleErrors.push(event.message);
        });
        try {
          await window.loadURL(targetUrl);
          await delay(350);
          const result = await window.webContents.executeJavaScript(`
            (async () => {
              const wait = () => new Promise((resolve) => setTimeout(resolve, 70));
              const button = (label) =>
                [...document.querySelectorAll("button")].find((item) =>
                  item.textContent?.trim().includes(label),
                );
              const exactButton = (label) =>
                [...document.querySelectorAll("button")].find(
                  (item) => item.textContent?.trim() === label,
                );
              const click = async (label, exact = false) => {
                let target;
                for (let attempt = 0; attempt < 20; attempt += 1) {
                  target = exact ? exactButton(label) : button(label);
                  if (target instanceof HTMLButtonElement) break;
                  await wait();
                }
                if (!(target instanceof HTMLButtonElement)) throw new Error(label + " button missing.");
                target.click();
                await wait();
              };

              if (!document.querySelector(".desktop-shell.shell-hub .activity-rail")) {
                throw new Error("Project-first Hub shell did not render.");
              }
              if (document.querySelector(".section-heading h1")?.textContent?.trim() !== "Projects") {
                throw new Error("Desktop did not start in Projects Hub.");
              }
              await click("Open Workspace");
              if (!document.querySelector(".desktop-shell.shell-project .project-workbench")) {
                throw new Error("Project selection did not replace the whole app shell.");
              }
              const titlebar = document.querySelector(".shell-titlebar");
              const workbenchTabs = document.querySelector(".shell-titlebar-actions .workbench-tabs");
              if (!(titlebar instanceof HTMLElement) || !(workbenchTabs instanceof HTMLElement)) {
                throw new Error("Workbench tabs did not move into the top titlebar.");
              }
              const titlebarBounds = titlebar.getBoundingClientRect();
              const tabBounds = workbenchTabs.getBoundingClientRect();
              if (
                tabBounds.top < titlebarBounds.top ||
                tabBounds.bottom > titlebarBounds.bottom + 1 ||
                tabBounds.right > titlebarBounds.right
              ) {
                throw new Error("Workbench tabs escaped the top-right titlebar slot.");
              }
              const interactionProbe = document.querySelector(".activity-rail button");
              if (
                !(interactionProbe instanceof HTMLButtonElement) ||
                !getComputedStyle(interactionProbe).transitionProperty.includes("transform")
              ) {
                throw new Error("Tactile button feedback is missing.");
              }
              const liveIndicator = document.querySelector(".shell-runtime-status .live-dot");
              if (
                !(liveIndicator instanceof HTMLElement) ||
                getComputedStyle(liveIndicator).animationName !== "live-breathe"
              ) {
                throw new Error("Live runtime feedback is missing.");
              }
              if (!document.querySelector(".file-explorer")) {
                throw new Error("Files did not open as the default Workbench resource.");
              }
              await click("Assets", true);
              await click("Scripts", true);
              await click("PlayerController.cs", true);
              if (!document.querySelector(".code-preview")?.textContent?.includes("PlayerController")) {
                throw new Error("Read-only project source did not render.");
              }

              await click("Runs");
              const activeRun = [...document.querySelectorAll(".work-run-card")].find((item) =>
                item.textContent?.includes("inventory-stack"),
              );
              if (!(activeRun instanceof HTMLButtonElement)) {
                throw new Error("Active Run was missing from Run History.");
              }
              activeRun.click();
              let liveRunReady = false;
              for (let attempt = 0; attempt < 20; attempt += 1) {
                await wait();
                const selectedWorkbenchTab = document.querySelector(".workbench-tabs button.selected");
                liveRunReady =
                  selectedWorkbenchTab?.textContent?.trim() === "Work & Runs" &&
                  Boolean(document.querySelector(".live-run-banner")) &&
                  Boolean(document.querySelector(".utility-drawer.open .terminal-panel"));
                if (liveRunReady) break;
              }
              if (!liveRunReady) {
                throw new Error(
                  "Selecting an active Run did not open its live Workbench and CLI: " +
                    JSON.stringify({
                      selectedTab: document
                        .querySelector(".workbench-tabs button.selected")
                        ?.textContent?.trim(),
                      liveBanner: Boolean(document.querySelector(".live-run-banner")),
                      utilityOpen: Boolean(document.querySelector(".utility-drawer.open")),
                      terminalPanel: Boolean(document.querySelector(".terminal-panel")),
                      loading: Boolean(document.querySelector(".loading-workspace")),
                      currentState: document.querySelector(".current-step h2")?.textContent?.trim(),
                      resultTitle: document.querySelector(".result-banner h2")?.textContent?.trim(),
                      error: document.querySelector(".error-toast span")?.textContent?.trim(),
                    }),
                );
              }
              let liveOutputReady = false;
              for (let attempt = 0; attempt < 20; attempt += 1) {
                await wait();
                liveOutputReady = Boolean(
                  document.querySelector(".utility-drawer.open .terminal-panel")?.textContent?.includes(
                    "Inspecting the selected Run.",
                  ),
                );
                if (liveOutputReady) break;
              }
              if (!liveOutputReady) throw new Error("Selected Run CLI output did not stream live.");
              await click("Agent CLI", true);
              if (!document.querySelector(".interactive-terminal")) {
                throw new Error("Native Agent terminal did not render.");
              }
              await click("Start terminal");
              let terminalReady = false;
              for (let attempt = 0; attempt < 20; attempt += 1) {
                await wait();
                terminalReady =
                  (document.querySelector(".interactive-terminal .xterm-rows")?.textContent ?? "").includes(
                    "MyUnityGame",
                  );
                if (terminalReady) break;
              }
              if (!terminalReady) throw new Error("Interactive PTY output did not stream.");

              await click("Work Map", true);
              if (!document.querySelector(".work-dag .dag-integration-card")) {
                throw new Error("Work Map DAG did not render.");
              }
              await click("Worktrees", true);
              if (!document.querySelector(".worktree-repository-card")) {
                throw new Error("Git Worktrees view did not render.");
              }
              await click("Project", true);
              if (!document.querySelector(".project-operations-view .operations-grid")) {
                throw new Error("Project Operations did not render.");
              }
              await click("Settings", true);
              if (!document.querySelector(".desktop-preferences-panel")) {
                throw new Error("Desktop preferences did not render.");
              }

              await click("New Work", true);
              const textarea = document.querySelector(".task-field textarea");
              if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Task input missing.");
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
              setter?.call(textarea, "Add inventory stacking");
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              await click("Run Doctor");
              for (let attempt = 0; attempt < 20 && button("Run Work")?.disabled; attempt += 1) await wait();
              await click("Run Work");
              if (!document.querySelector(".plan-review-dialog")?.textContent?.includes("Review the Work DAG")) {
                throw new Error("Plan approval gate did not render before execution.");
              }
              if (!button("Approve plan & start")) throw new Error("Plan approval action is missing.");

              return {
                projectHub: true,
                projectShell: true,
                topRightWorkbenchTabs: true,
                microInteractions: true,
                files: true,
                liveRunWorkbench: true,
                interactivePty: true,
                workMap: true,
                worktrees: true,
                projectOperations: true,
                settings: true,
                planApproval: true,
              };
            })()
          `);
          if (consoleErrors.length > 0) {
            throw new Error(`Renderer console errors: ${consoleErrors.join(" | ")}`);
          }
          window.setContentSize(1100, 720);
          await delay(100);
          const compactLayout = await window.webContents.executeJavaScript(`
            document.documentElement.scrollWidth <= window.innerWidth &&
              Boolean(document.querySelector(".desktop-shell")) &&
              Boolean(document.querySelector(".activity-rail"))
          `);
          if (!compactLayout) throw new Error("Project-first shell overflowed at 1100x720.");
          window.setContentSize(1440, 1024);
          await delay(100);
          await writeFile(outputPath, (await window.webContents.capturePage()).toPNG());
          process.stdout.write(
            `HONEYBEE_DESKTOP_VISUAL_SMOKE_OK ${JSON.stringify({ ...result, compactLayout })}\n`,
          );
          window.destroy();
          app.exit(0);
        } catch (error) {
          if (!window.isDestroyed()) window.destroy();
          fail(error);
        }
      })
      .catch(fail);
  }
}
