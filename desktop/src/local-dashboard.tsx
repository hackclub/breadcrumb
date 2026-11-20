import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TimeDashboard } from "../../web/app/time-dashboard";
import { REFERENCE, calendarClock, type InsightDay } from "../../web/lib/insights";
import { applyTheme, readTheme } from "../../web/lib/theme";
import InsightsWorker from "./local-insights-worker?worker&inline";
import { engine, isNative } from "./bridge";
import type { State } from "./types";

export async function openLocalDashboard() {
  if (isNative) await invoke("open_dashboard");
  else window.open("/?view=dashboard", "breadcrumb-dashboard");
}

export function LocalDashboard() {
  const [days, setDays] = useState<InsightDay[] | null>(null);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  useEffect(() => {
    let worker: Worker;
    try {
      worker = new InsightsWorker();
    } catch {
      setError("Could not load local insights. Reopen the dashboard to try again.");
      return;
    }
    let stopped = false,
      pending = false,
      previous = "";
    worker.onmessage = (event) => {
      pending = false;
      if (stopped) return;
      if (event.data.error) {
        previous = "";
        setError(event.data.error);
      } else {
        setDays(event.data.days);
        setError("");
      }
    };
    worker.onerror = () => {
      pending = false;
      previous = "";
      setError("Could not load local insights. Reopen the dashboard to try again.");
    };
    const load = async () => {
      applyTheme(readTheme());
      if (pending || stopped || document.hidden) return;
      pending = true;
      try {
        const state = await engine<State>("state");
        if (stopped) return;
        setDemo(state.demo);
        const last = state.observations.at(-1);
        const now = Date.now() / 1000 - REFERENCE;
        const edge = last
          ? Math.min(
              now,
              last.date + Math.min(300, Math.max(15, last.sampleIntervalSeconds ?? 60)) / 2,
            )
          : 0;
        const signature =
          JSON.stringify(state.observations) + edge + calendarClock(timeZone)(now).day;
        if (signature === previous) {
          pending = false;
          return;
        }
        previous = signature;
        worker.postMessage({ records: state.observations, timeZone });
      } catch {
        pending = false;
        setError("Could not open local history. Try reopening the dashboard.");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    window.addEventListener("focus", load);
    window.addEventListener("storage", load);
    return () => {
      stopped = true;
      clearInterval(timer);
      worker.terminate();
      window.removeEventListener("focus", load);
      window.removeEventListener("storage", load);
    };
  }, [timeZone]);
  return (
    <main className="local-dashboard">
      <div className="local-dashboard-heading">
        <span>Breadcrumb</span>
        <span>{demo ? "Example history" : "On this device"}</span>
      </div>
      {error && <p role="alert">{error}</p>}
      <TimeDashboard days={days ?? []} loading={days === null} timeZone={timeZone} local />
    </main>
  );
}
