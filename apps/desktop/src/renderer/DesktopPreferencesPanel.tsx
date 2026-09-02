import { useEffect, useRef, useState } from "react";
import { Gauge, SidebarSimple, SlidersHorizontal, TextT } from "@phosphor-icons/react";

import type { DesktopPreferencesV1 } from "../shared/ipc.js";

interface DesktopPreferencesPanelProps {
  onChange(preferences: DesktopPreferencesV1): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

export function DesktopPreferencesPanel({
  onChange,
  onError,
  onNotice,
}: DesktopPreferencesPanelProps) {
  const [preferences, setPreferences] = useState<DesktopPreferencesV1>();
  const [busy, setBusy] = useState(false);
  const onErrorRef = useRef(onError);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onErrorRef.current = onError;
    onChangeRef.current = onChange;
  }, [onChange, onError]);

  useEffect(() => {
    void window.honeybee
      .preferences()
      .then((value) => {
        setPreferences(value);
        onChangeRef.current(value);
      })
      .catch((error: unknown) =>
        onErrorRef.current(
          error instanceof Error ? error.message : "Could not read Desktop preferences.",
        ),
      );
  }, []);

  const update = async (patch: Partial<DesktopPreferencesV1>): Promise<void> => {
    if (preferences === undefined) return;
    setBusy(true);
    try {
      const next = await window.honeybee.updatePreferences({ ...preferences, ...patch });
      setPreferences(next);
      onChange(next);
      onNotice("Desktop preferences saved.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not save Desktop preferences.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="desktop-preferences-panel surface">
      <header>
        <span className="settings-panel-icon">
          <SlidersHorizontal size={22} weight="duotone" />
        </span>
        <div>
          <span className="eyebrow">APPEARANCE & WORKBENCH</span>
          <h2>Desktop preferences</h2>
          <p>Choose how much information HoneyBee fits on screen and where a project opens.</p>
        </div>
      </header>
      <div className="preference-grid">
        <label>
          <Gauge size={17} />
          <span>
            <strong>Interface density</strong>
            <small>Compact reduces navigation and card spacing.</small>
          </span>
          <select
            value={preferences?.density ?? "comfortable"}
            disabled={busy || preferences === undefined}
            onChange={(event) =>
              void update({ density: event.target.value as DesktopPreferencesV1["density"] })
            }
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label>
          <TextT size={17} />
          <span>
            <strong>Terminal font</strong>
            <small>Native Agent CLI and PowerShell text size.</small>
          </span>
          <input
            type="number"
            min={10}
            max={18}
            value={preferences?.terminalFontSize ?? 12}
            disabled={busy || preferences === undefined}
            onChange={(event) =>
              void update({
                terminalFontSize: Math.max(10, Math.min(18, Number(event.target.value) || 12)),
              })
            }
          />
        </label>
        <label>
          <SidebarSimple size={17} />
          <span>
            <strong>Explorer width</strong>
            <small>Project file tree width in pixels.</small>
          </span>
          <input
            type="number"
            min={220}
            max={420}
            step={10}
            value={preferences?.fileExplorerWidth ?? 280}
            disabled={busy || preferences === undefined}
            onChange={(event) =>
              void update({
                fileExplorerWidth: Math.max(220, Math.min(420, Number(event.target.value) || 280)),
              })
            }
          />
        </label>
        <label>
          <SlidersHorizontal size={17} />
          <span>
            <strong>Project opens to</strong>
            <small>The first Workbench resource after project selection.</small>
          </span>
          <select
            value={preferences?.workbenchDefault ?? "files"}
            disabled={busy || preferences === undefined}
            onChange={(event) =>
              void update({
                workbenchDefault: event.target.value as DesktopPreferencesV1["workbenchDefault"],
              })
            }
          >
            <option value="files">Files</option>
            <option value="agent">Agent CLI</option>
            <option value="shell">Shell</option>
            <option value="work">Work & Runs</option>
          </select>
        </label>
        <label className="preference-checkbox">
          <Gauge size={17} />
          <span>
            <strong>Reduce motion</strong>
            <small>Disable non-essential spinners and transitions.</small>
          </span>
          <input
            type="checkbox"
            checked={preferences?.reducedMotion ?? false}
            disabled={busy || preferences === undefined}
            onChange={(event) => void update({ reducedMotion: event.target.checked })}
          />
        </label>
      </div>
    </section>
  );
}
