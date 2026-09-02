import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { TerminalWindowApp } from "./TerminalPanel.js";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./dashboard.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Desktop root element is missing.");

const terminalWindow = new URLSearchParams(window.location.search).get("view") === "terminal";

createRoot(root).render(
  <StrictMode>{terminalWindow ? <TerminalWindowApp /> : <App />}</StrictMode>,
);
