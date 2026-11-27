import { AgentUsageView } from "../../web/app/agent-usage-view";
import { useEffect, useState } from "react";
import { TimeDashboard } from "../../web/app/time-dashboard";
import { REFERENCE, calendarClock, type InsightDay } from "../../web/lib/insights";
import { applyTheme, readTheme } from "../../web/lib/theme";
import InsightsWorker from "./local-insights-worker?worker&inline";
import { engine, isNative } from "./bridge";
import type { State } from "./types";
import type { AgentUsage } from "./agent-usage-types";
import "../../web/app/dashboard.css";
import "./local-dashboard.css";

// Loaded only in the dashboard window, so the tray popup never parses this code.
const loadUsage = (range: number, timeZone: string) =>
  engine<AgentUsage>("agentUsage", { range, timeZone });

export function LocalDashboard() {
  const [view, setView] = useState("time");
  const [days, setDays] = useState<InsightDay[] | null>(null);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(!isNative);
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
      <nav aria-label="Dashboard view" className="agent-controls">
        {[
          ["time", "Time"],
          ["agents", "Coding agents"],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {view === "agents" ? (
        <AgentUsageView loadUsage={loadUsage} />
      ) : (
        <TimeDashboard days={days ?? []} loading={days === null} timeZone={timeZone} local />
      )}
    </main>
  );
}
