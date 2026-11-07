import { desktopApi } from "../desktop-api.js";
import { ArrowsOutSimple, Minus, X } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { About } from "./About.js";

import type { Locale, MessageKey } from "../i18n.js";
import { UpdateCheck } from "./UpdateCheck.js";

export function AppFrame({
  children,
  locale,
  setLocale,
  onStorageRecovery,
  t,
}: {
  onStorageRecovery: () => void;
  children: ReactNode;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}) {
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <img src="./honeybee.png" alt="" />
          <strong>HoneyBee</strong>
        </div>
        <div className="titlebar-drag" />
        <button className="locale-button" onClick={() => setAboutOpen(true)}>
          {locale === "ko" ? "앱 정보" : "About"}
        </button>
        <button
          className="locale-button"
          data-testid="storage-recovery-open"
          onClick={onStorageRecovery}
        >
          {locale === "ko" ? "스토리지 복구" : "Storage recovery"}
        </button>
        <UpdateCheck locale={locale} onRecovery={onStorageRecovery} />
        <button
          className="locale-button"
          data-testid="locale-toggle"
          onClick={() => setLocale(locale === "ko" ? "en" : "ko")}
        >
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
      {aboutOpen && <About locale={locale} onClose={() => setAboutOpen(false)} />}
    </main>
  );
}
