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
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        window.webContents.on("console-message", (event) => {
          if (event.level === "error") consoleErrors.push(event.message);
        });
        try {
          await window.loadURL(targetUrl);
          await delay(500);
          const result = await window.webContents.executeJavaScript(`
            (async () => {
              const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
              const button = (label) =>
                [...document.querySelectorAll("button")].find((item) =>
                  item.textContent?.trim().includes(label),
                );
              const title = () => document.querySelector(".section-heading h1")?.textContent?.trim();
              if (!document.querySelector(".brand-lockup")) {
                throw new Error("State-driven Desktop shell did not render.");
              }
              let terminalAutoOpened = false;
              for (let attempt = 0; attempt < 30; attempt += 1) {
                await wait();
                terminalAutoOpened = Boolean(
                  document.querySelector(".utility-drawer.open .terminal-panel"),
                );
                if (terminalAutoOpened) break;
              }
              if (!terminalAutoOpened) {
                throw new Error("Active Run did not auto-open the Live CLI.");
              }

              button("Projects")?.click();
              await wait();
              if (title() !== "Projects") throw new Error("Projects navigation failed.");

              button("Agents")?.click();
              await wait();
              if (title() !== "Agents") throw new Error("Agent Manager navigation failed.");
              if (!document.querySelector(".agent-card")) {
                throw new Error("Agent Manager did not render a connected Agent.");
              }

              button("New Work")?.click();
              await wait();
              const textarea = document.querySelector(".task-field textarea");
              if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Task input missing.");
              const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
              )?.set;
              setter?.call(textarea, "Add inventory stacking");
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              await wait();
              if (textarea.value !== "Add inventory stacking") throw new Error("Task input failed.");

              const compile = [...document.querySelectorAll(".toggle-chip")].find((item) =>
                item.textContent?.includes("Compile"),
              )?.querySelector("input");
              if (!(compile instanceof HTMLInputElement)) {
                throw new Error("Compile capability control is missing.");
              }
              const compileInitiallyChecked = compile.checked;
              compile.click();
              await wait();
              if (compile.checked === compileInitiallyChecked) {
                throw new Error("Compile capability did not toggle.");
              }
              compile.click();
              await wait();
              if (compile.checked !== compileInitiallyChecked) {
                throw new Error("Compile capability did not restore.");
              }

              const utility = document.querySelector(".utility-status-bar");
              if (!(utility instanceof HTMLButtonElement)) throw new Error("Utility drawer missing.");
              utility.click();
              await wait();
              button("Runs")?.click();
              await wait();
              const completed = [...document.querySelectorAll(".utility-run-list button")].find(
                (item) => item.textContent?.includes("Fix Player Movement Jitter"),
              );
              if (!(completed instanceof HTMLButtonElement)) {
                throw new Error("Completed Run navigation target missing.");
              }
              completed.click();
              let patchReview = false;
              for (let attempt = 0; attempt < 40; attempt += 1) {
                await wait();
                patchReview = Boolean(document.querySelector(".patch-workbench"));
                if (patchReview) break;
              }
              if (!patchReview) {
                throw new Error("Verified patch review did not render.");
              }
              const evidence = button("Review evidence");
              if (!(evidence instanceof HTMLButtonElement)) {
                throw new Error("Review evidence action is missing.");
              }
              evidence.click();
              await wait();
              const activity = document.querySelector(".utility-drawer.open .utility-activity");
              if (
                !activity?.textContent?.includes("Verified patch is ready for disposition.") ||
                !activity.textContent.includes("unity-verified-patch")
              ) {
                throw new Error("Selected Run evidence did not render in Activity.");
              }

              button("Live CLI")?.click();
              let terminalReady = false;
              for (let attempt = 0; attempt < 30; attempt += 1) {
                await wait();
                const rows = document.querySelector(".terminal-panel .xterm-rows");
                terminalReady =
                  Boolean(document.querySelector(".terminal-panel")) &&
                  Boolean(button("Open in window")) &&
                  (rows?.textContent ?? "").includes("Terminal stream ready.");
                if (terminalReady) break;
              }
              if (!terminalReady) {
                throw new Error("Delayed Live CLI output or external window action is missing.");
              }

              return {
                navigation: true,
                taskInput: true,
                capabilityToggle: true,
                patchReview: true,
                evidenceReview: true,
                liveCli: true,
                terminalAutoOpened: true,
              };
            })()
          `);
          if (consoleErrors.length > 0) {
            throw new Error(`Renderer console errors: ${consoleErrors.join(" | ")}`);
          }
          window.setContentSize(1024, 800);
          await delay(100);
          const compactLayout = await window.webContents.executeJavaScript(`
            document.documentElement.scrollWidth <= window.innerWidth &&
              Boolean(document.querySelector(".brand-lockup")) &&
              Boolean(document.querySelector(".new-work-button"))
          `);
          if (!compactLayout) {
            throw new Error("Desktop workspace overflowed at the 1024px compact viewport.");
          }
          window.setContentSize(1440, 1024);
          await window.webContents.reload();
          let reviewReady = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await delay(50);
            reviewReady = await window.webContents.executeJavaScript(
              `Boolean(document.querySelector(".patch-workbench"))`,
            );
            if (reviewReady) break;
          }
          if (!reviewReady) {
            throw new Error("Verified patch review did not remain stable for capture.");
          }
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
