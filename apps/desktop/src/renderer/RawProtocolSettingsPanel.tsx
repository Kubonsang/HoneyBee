import { useEffect, useRef, useState } from "react";
import { ShieldWarning } from "@phosphor-icons/react";

import type { DesktopDeveloperSettingsV1 } from "../shared/ipc.js";

interface RawProtocolSettingsPanelProps {
  onError(message: string): void;
  onNotice(message: string): void;
}

export function RawProtocolSettingsPanel({ onError, onNotice }: RawProtocolSettingsPanelProps) {
  const [settings, setSettings] = useState<DesktopDeveloperSettingsV1>();
  const [busy, setBusy] = useState(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    void window.honeybee
      .developerSettings()
      .then(setSettings)
      .catch((error: unknown) =>
        onErrorRef.current(
          error instanceof Error ? error.message : "Could not read Developer Settings.",
        ),
      );
  }, []);

  const toggle = async (enabled: boolean): Promise<void> => {
    if (
      enabled &&
      !window.confirm(
        "Raw Agent Protocol can contain prompts, file contents, and tool arguments. Enable local display?",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const current = await window.honeybee.developerSettings();
      const next = await window.honeybee.updateDeveloperSettings({
        ...current,
        rawAgentProtocolEnabled: enabled,
      });
      setSettings(next);
      onNotice(enabled ? "Raw Agent Protocol display enabled." : "Raw Agent Protocol hidden.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update Developer Settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="raw-protocol-panel surface">
      <div>
        <span className="raw-protocol-icon">
          <ShieldWarning size={22} weight="duotone" />
        </span>
        <div>
          <span className="eyebrow">DEVELOPER</span>
          <h2>Raw Agent Protocol</h2>
          <p>
            Allow the Live CLI to display local JSON-RPC messages. Environment variables and Native
            Host activation data are never included.
          </p>
        </div>
      </div>
      <label className="developer-toggle">
        <input
          type="checkbox"
          checked={settings?.rawAgentProtocolEnabled ?? false}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>{settings?.rawAgentProtocolEnabled ? "Enabled" : "Disabled"}</span>
      </label>
      <p className="raw-protocol-warning">
        Raw messages may contain prompts, file contents, and tool arguments. Keep this disabled
        unless you are diagnosing a Provider integration.
      </p>
    </section>
  );
}
