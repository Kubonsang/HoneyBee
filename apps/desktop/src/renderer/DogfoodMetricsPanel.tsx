import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, FolderOpen, Play, Stop, Wrench } from "@phosphor-icons/react";

import type { DesktopDeveloperSettingsV1, DesktopDogfoodStatusV1 } from "../shared/ipc.js";

interface DogfoodMetricsPanelProps {
  readonly profileId?: string;
  readonly compact?: boolean;
  onError(message: string): void;
  onNotice(message: string): void;
}

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "HoneyBee operation failed.";

const duration = (milliseconds: number | null | undefined): string => {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
};

export function DogfoodMetricsPanel({
  profileId,
  compact = false,
  onError,
  onNotice,
}: DogfoodMetricsPanelProps) {
  const [settings, setSettings] = useState<DesktopDeveloperSettingsV1>();
  const [status, setStatus] = useState<DesktopDogfoodStatusV1>();
  const [busy, setBusy] = useState<"toggle" | "start" | "finalize" | "open">();
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refresh = useCallback(async () => {
    const [developer, dogfood] = await Promise.all([
      window.honeybee.developerSettings(),
      window.honeybee.dogfoodStatus(),
    ]);
    setSettings(developer);
    setStatus(dogfood);
  }, []);

  useEffect(() => {
    void refresh().catch((error: unknown) => onErrorRef.current(readableError(error)));
  }, [refresh]);

  useEffect(() => {
    if (status?.state !== "recording") return;
    const timer = setInterval(
      () => void refresh().catch((error: unknown) => onErrorRef.current(readableError(error))),
      1_000,
    );
    return () => clearInterval(timer);
  }, [refresh, status?.state]);

  if (compact && settings?.dogfoodMetricsEnabled !== true) return null;

  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy("toggle");
    try {
      setSettings(
        await window.honeybee.updateDeveloperSettings({
          schemaVersion: 1,
          dogfoodMetricsEnabled: enabled,
        }),
      );
      await refresh();
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const start = async (): Promise<void> => {
    if (profileId === undefined) return;
    setBusy("start");
    try {
      setStatus(await window.honeybee.startDogfood({ schemaVersion: 1, profileId }));
      onNotice("Dogfood metrics recording started.");
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const finalize = async (): Promise<void> => {
    const sessionId = status?.session?.sessionId;
    if (sessionId === undefined) return;
    setBusy("finalize");
    try {
      const next = await window.honeybee.finalizeDogfood({ schemaVersion: 1, sessionId });
      setStatus(next);
      onNotice(`Dogfood Evidence finalized · ${next.state}`);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const openEvidence = async (): Promise<void> => {
    const sessionId = status?.session?.sessionId;
    if (sessionId === undefined) return;
    setBusy("open");
    try {
      if (!(await window.honeybee.openDogfoodEvidence({ schemaVersion: 1, sessionId }))) {
        throw new Error("Windows could not open the Evidence folder.");
      }
    } catch (error) {
      onError(readableError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const elapsed =
    status?.session === undefined
      ? undefined
      : Date.parse(status.observedAt) - Date.parse(status.session.startedAt);
  const summary = status?.session?.summary;

  return (
    <section className={`dogfood-panel surface${compact ? " compact" : ""}`}>
      <div className="dogfood-heading">
        <span className="dogfood-icon">
          {compact ? <Bug size={19} weight="duotone" /> : <Wrench size={21} weight="duotone" />}
        </span>
        <div>
          <span className="eyebrow">DEVELOPER</span>
          <h2>Dogfood Metrics</h2>
          {!compact && (
            <p>Record authoritative Journal, Artifact, timing, and residual Evidence.</p>
          )}
        </div>
        {!compact && (
          <label className="developer-toggle">
            <input
              type="checkbox"
              checked={settings?.dogfoodMetricsEnabled ?? false}
              disabled={busy !== undefined}
              onChange={(event) => void toggle(event.target.checked)}
            />
            <span>{settings?.dogfoodMetricsEnabled ? "Enabled" : "Disabled"}</span>
          </label>
        )}
      </div>

      {settings?.dogfoodMetricsEnabled && (
        <div className="dogfood-body">
          <div className={`dogfood-state ${status?.state ?? "idle"}`}>
            <strong>{(status?.state ?? "idle").replace("-", " ")}</strong>
            <span>
              {status?.state === "recording"
                ? `${duration(elapsed)} · ${status.session?.workCount ?? 0} Works captured`
                : status?.session === undefined
                  ? "Choose a project and start an explicit recording."
                  : `${summary?.completedWorks ?? 0}/${summary?.workCount ?? status.session.workCount} Works · ${duration(summary?.sessionWallClockMs)}`}
            </span>
          </div>
          {summary !== undefined && (
            <div className="dogfood-summary">
              <span>
                <strong>{summary.agentOverlapMs}</strong> ms overlap
              </span>
              <span>
                <strong>{summary.changedFiles}</strong> files
              </span>
              <span>
                <strong>{summary.testCount}</strong> tests
              </span>
              <span>
                <strong>{summary.residualTotal}</strong> residuals
              </span>
            </div>
          )}
          <div className="dogfood-actions">
            {status?.state === "recording" ? (
              <button
                className="primary"
                disabled={busy !== undefined}
                onClick={() => void finalize()}
              >
                <Stop size={16} weight="fill" /> Stop &amp; Finalize
              </button>
            ) : (
              <button
                className="primary"
                disabled={busy !== undefined || profileId === undefined}
                onClick={() => void start()}
              >
                <Play size={16} weight="fill" /> Start Recording
              </button>
            )}
            {status?.session !== undefined && status.state !== "recording" && (
              <>
                <button
                  className="secondary"
                  disabled={busy !== undefined}
                  onClick={() => void finalize()}
                >
                  Refresh Finalize
                </button>
                <button
                  className="secondary"
                  disabled={busy !== undefined}
                  onClick={() => void openEvidence()}
                >
                  <FolderOpen size={16} /> Open Evidence Folder
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
