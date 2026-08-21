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
          width: 1536,
          height: 1024,
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
              const title = () => document.querySelector(".page-heading h1")?.textContent?.trim();
              if (title() !== "Command Center") throw new Error("Command Center did not render.");

              button("New Work")?.click();
              await wait();
              if (title() !== "MyUnityGame") throw new Error("New Work navigation failed.");

              button("Run History")?.click();
              await wait();
              if (title() !== "Run History") throw new Error("Run History navigation failed.");

              button("Command Center")?.click();
              await wait();
              if (title() !== "Command Center") throw new Error("Command Center return failed.");

              const textarea = document.querySelector(".quick-composer textarea");
              if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Task input missing.");
              const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
              )?.set;
              setter?.call(textarea, "Add inventory stacking");
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              await wait();
              if (textarea.value !== "Add inventory stacking") throw new Error("Task input failed.");

              const compile = [...document.querySelectorAll(".capability-chip")].find((item) =>
                item.textContent?.includes("Compile"),
              )?.querySelector("input");
              if (!(compile instanceof HTMLInputElement) || !compile.checked) {
                throw new Error("Compile capability control is missing.");
              }
              compile.click();
              await wait();
              if (compile.checked) throw new Error("Compile capability did not toggle.");
              compile.click();
              await wait();
              if (!compile.checked) throw new Error("Compile capability did not restore.");

              return { navigation: true, taskInput: true, capabilityToggle: true };
            })()
          `);
          if (consoleErrors.length > 0) {
            throw new Error(`Renderer console errors: ${consoleErrors.join(" | ")}`);
          }
          await writeFile(outputPath, (await window.webContents.capturePage()).toPNG());
          process.stdout.write(`HONEYBEE_DESKTOP_VISUAL_SMOKE_OK ${JSON.stringify(result)}\n`);
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
