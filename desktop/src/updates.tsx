import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction, isNative } from "./bridge";
import { bytes } from "./types";

type UpdateInfo = {
  currentVersion: string;
  version: string | null;
  notes: string | null;
  checkedAt: number | null;
  failed: boolean;
};
type Progress = { downloaded: number; total: number | null };
const CHECK_ERROR = "Could not check for updates. Check your connection and try again.";
export function useUpdates() {
  const [info, setInfo] = useState<UpdateInfo>({
    currentVersion: "",
    version: null,
    notes: null,
    checkedAt: null,
    failed: false,
  });
  const [phase, setPhase] = useState("idle"),
    [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress>({ downloaded: 0, total: null });
  const pending = useRef(false);
  const receive = useCallback((result: UpdateInfo) => {
    setInfo(result);
    setError(result.failed ? CHECK_ERROR : "");
    setPhase(
      result.failed
        ? "error"
        : result.version
          ? "available"
          : result.checkedAt
            ? "current"
            : "idle",
    );
  }, []);
  const check = useCallback(async () => {
    if (!isNative || pending.current) return;
    pending.current = true;
    setPhase("checking");
    setError("");
    try {
      receive(await invoke<UpdateInfo>("check_updates"));
    } catch {
      setError(CHECK_ERROR);
      setPhase("error");
    } finally {
      pending.current = false;
    }
  }, [receive]);
  useEffect(() => {
    if (!isNative) return;
    const load = () =>
      void invoke<UpdateInfo>("update_status")
        .then((status) => {
          if (pending.current) return;
          receive(status);
          // Catch up after sleep; regular polling lives in Rust, outside the hidden webview.
          if (status.checkedAt && Date.now() - status.checkedAt >= 4 * 60 * 60 * 1000) void check();
        })
        .catch(() => {});
    load();
    const online = () => void check();
    window.addEventListener("focus", load);
    window.addEventListener("online", online);
    let disposed = false;
    const stops: (() => void)[] = [];
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const subscriptions = await Promise.allSettled([
          listen<UpdateInfo>("update-checked", ({ payload }) => {
            if (!pending.current) receive(payload);
          }),
          listen<Progress>("update-progress", ({ payload }) => setProgress(payload)),
        ]);
        for (const result of subscriptions)
          if (result.status === "fulfilled") {
            if (disposed) result.value();
            else stops.push(result.value);
          }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      window.removeEventListener("focus", load);
      window.removeEventListener("online", online);
    };
  }, [check, receive]);
  async function install() {
    if (
      pending.current ||
      !info.version ||
      !(await confirmAction(
        `Install Breadcrumb ${info.version} and restart? Your local history and settings will be kept.`,
      ))
    )
      return;
    if (pending.current) return;
    pending.current = true;
    setPhase("installing");
    setError("");
    setProgress({ downloaded: 0, total: null });
    try {
      await invoke("install_update", { version: info.version });
    } catch {
      setError(
        "Update could not be installed. The download must have a valid Breadcrumb signature. Try again or use the installer.",
      );
      setPhase("error");
    } finally {
      pending.current = false;
    }
  }
  return { ...info, phase, error, progress, check, install };
}
export type AppUpdates = ReturnType<typeof useUpdates>;
export function UpdatesSection({ updates }: { updates: AppUpdates }) {
  const installing = updates.phase === "installing";
  const busy = installing || updates.phase === "checking";
  const progress = updates.progress.total
    ? Math.min(100, (updates.progress.downloaded / updates.progress.total) * 100)
    : undefined;
  return (
    <section className="settings-section">
      <h2>Updates</h2>
      <div className="setting-row">
        <span>Breadcrumb</span>
        <span>{updates.currentVersion || (isNative ? "…" : "Browser preview")}</span>
      </div>
      <p role="status" aria-label="Update status">
        {installing
          ? `Downloading ${bytes(updates.progress.downloaded)}${updates.progress.total ? ` of ${bytes(updates.progress.total)}` : ""}…`
          : updates.version
            ? `Version ${updates.version} is available.`
            : updates.phase === "checking"
              ? "Checking for updates…"
              : updates.phase === "current"
                ? "No updates available."
                : "Checks automatically every four hours."}
      </p>
      {installing && <progress aria-label="Update download" value={progress} max={100} />}
      {updates.error && <p role="alert">{updates.error}</p>}
      {updates.notes && (
        <details>
          <summary>What’s new</summary>
          <p className="update-notes">{updates.notes}</p>
        </details>
      )}
      <div className="actions">
        <button disabled={!isNative || busy} onClick={() => void updates.check()}>
          {updates.phase === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {updates.version && (
          <button className="primary" disabled={busy} onClick={() => void updates.install()}>
            {installing ? "Installing…" : "Install & restart"}
          </button>
        )}
      </div>
    </section>
  );
}
