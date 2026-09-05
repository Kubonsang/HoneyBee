import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { TerminalProvider } from "./terminal-store.js";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Desktop root element is missing.");

createRoot(root).render(
  <StrictMode>
    <TerminalProvider>
      <App />
    </TerminalProvider>
  </StrictMode>,
);
