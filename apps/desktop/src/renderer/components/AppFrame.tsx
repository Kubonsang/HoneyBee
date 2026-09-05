import { desktopApi } from "../desktop-api.js";
import { ArrowsOutSimple, Minus, X } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { Locale, MessageKey } from "../i18n.js";

export function AppFrame({
  children,
  locale,
  setLocale,
  t,
}: {
  children: ReactNode;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <img src="./honeybee.png" alt="" />
          <strong>HoneyBee</strong>
        </div>
        <div className="titlebar-drag" />
        <button className="locale-button" onClick={() => setLocale(locale === "ko" ? "en" : "ko")}>
          {t("language")}
        </button>
        <div className="window-controls">
          <button
            aria-label="Minimize"
            onClick={() => void desktopApi.windowAction({ action: "minimize" })}
          >
            <Minus size={15} />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => void desktopApi.windowAction({ action: "toggle-maximize" })}
          >
            <ArrowsOutSimple size={14} />
          </button>
          <button
            className="window-close"
            aria-label="Close"
            onClick={() => void desktopApi.windowAction({ action: "close" })}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      {children}
    </main>
  );
}
