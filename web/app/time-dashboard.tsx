"use client";
import { useEffect, useState } from "react";
import { duration, type Breakdown, type InsightDay } from "../lib/insights";
import { appSeed, findApp, type AppEntry } from "../lib/apps";
import { AppIcon } from "./app-icon";

function combined(days: InsightDay[], key: "apps" | "activities" | "projects"): Breakdown {
  const totals = new Map<string, Breakdown[number]>();
  for (const day of days)
    for (const item of day[key] ?? [
      { name: key === "projects" ? "Unassigned" : "Not indexed yet", seconds: day.seconds },
    ]) {
      const key = item.id || item.name;
      totals.set(key, { ...item, seconds: (totals.get(key)?.seconds ?? 0) + item.seconds });
    }
  return [...totals.values()].sort((a, b) => b.seconds - a.seconds);
}
function Ranking({ rows, total, apps }: { rows: Breakdown; total: number; apps?: AppEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ranking">
      {(expanded ? rows : rows.slice(0, 6)).map((row) => (
        <div className="rank-row" key={row.id || row.name}>
          <span className="rank-name" title={row.name}>
            {apps ? (
              <AppIcon apps={apps} name={row.name} id={row.id} />
            ) : (
              <span className="app-monogram" aria-hidden="true">
                {row.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            {apps ? findApp(apps, row.name, row.id)?.name || row.name : row.name}
          </span>
          <strong>{duration(row.seconds)}</strong>
          <span className="rank-percent">
            {total ? Math.round((row.seconds / total) * 100) : 0}%
          </span>
          <span className="rank-track">
            <span style={{ width: `${total ? (row.seconds / total) * 100 : 0}%` }} />
          </span>
        </div>
      ))}
      {rows.length > 6 && (
        <button className="quiet show-all" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show all ${rows.length}`}
        </button>
      )}
      {!rows.length && <p className="muted">Your breakdown will appear as captures sync.</p>}
    </div>
  );
}
export function TimeDashboard({ days }: { days: InsightDay[] }) {
  const [range, setRange] = useState("7"),
    [selected, setSelected] = useState<string | null>(null),
    [hourSelection, setHourSelection] = useState<{ day: string; hour: number } | null>(null),
    [catalog, setCatalog] = useState<AppEntry[]>(appSeed),
    [breakdown, setBreakdown] = useState<"apps" | "activities">("apps");
  const today = new Date().toISOString().slice(0, 10);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/apps", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (Array.isArray(value?.apps) && !controller.signal.aborted) setCatalog(value.apps);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const end = Date.parse(today);
  const cutoff = range === "all" ? -Infinity : end - (Number(range) - 1) * 86400000;
  const period = days
    .filter((day) => Date.parse(day.day) >= cutoff && Date.parse(day.day) <= end)
    .sort((a, b) => a.day.localeCompare(b.day));
  const filtered = selected ? period.filter((day) => day.day === selected) : period;
  const total = filtered.reduce((sum, day) => sum + day.seconds, 0);
  const captures = filtered.reduce((sum, day) => sum + day.captures, 0);
  const apps = combined(filtered, "apps");
  const chartDays: InsightDay[] = [];
  const start =
    range === "all"
      ? Math.max(period[0] ? Date.parse(period[0].day) : end, end - 89 * 86400000)
      : cutoff;
  const lookup = new Map(period.map((day) => [day.day, day]));
  for (let date = start; date <= end; date += 86400000) {
    const day = new Date(date).toISOString().slice(0, 10);
    chartDays.push(lookup.get(day) ?? { day, seconds: 0, captures: 0, lastSynced: "" });
  }
  const maximum = Math.max(3600, ...chartDays.map((day) => day.seconds));
  const heatmapDays = selected
    ? chartDays.filter((day) => day.day === selected)
    : chartDays.slice(-14);
  const hourDay = hourSelection ? lookup.get(hourSelection.day) : undefined;
  const hourDetail = hourSelection ? hourDay?.hourly?.[hourSelection.hour] : undefined;
  const readable = (day: string) =>
    new Date(day + "T12:00:00Z").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return (
    <>
      <div className="insights-toolbar">
        <div>
          <h1>Where your time went</h1>
          <p className="muted">A little perspective on your days.</p>
        </div>
        <select
          aria-label="Time range"
          value={range}
          onChange={(event) => {
            setRange(event.target.value);
            setSelected(null);
            setHourSelection(null);
          }}
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </div>
      <div className="insight-stats">
        <div>
          <span>Estimated time</span>
          <strong>{duration(total)}</strong>
          <small>
            {selected
              ? readable(selected)
              : `${filtered.filter((day) => day.seconds > 0).length} active days`}
          </small>
        </div>
        <div>
          <span>Most used app</span>
          <strong className="stat-app" title={apps[0]?.name}>
            {apps[0] ? findApp(catalog, apps[0].name, apps[0].id)?.name || apps[0].name : "—"}
          </strong>
          <small>{apps[0] ? duration(apps[0].seconds) : "Waiting for captures"}</small>
        </div>
        <div>
          <span>Captures synced</span>
          <strong>{captures.toLocaleString()}</strong>
          <small>Overlapping time counts once</small>
        </div>
      </div>
      <section className="insight-panel daily-panel" aria-label="Daily activity">
        <div className="panel-heading">
          <h2>Daily rhythm</h2>
          <span>
            {selected ? (
              <button className="quiet" onClick={() => setSelected(null)}>
                Clear day ×
              </button>
            ) : (
              "Select a day to explore"
            )}
          </span>
        </div>
        <div
          className="daily-chart"
          style={{ gridTemplateColumns: `repeat(${chartDays.length}, minmax(12px,1fr))` }}
        >
          {chartDays.map((day, index) => (
            <button
              key={day.day}
              aria-label={`${readable(day.day)}: ${duration(day.seconds)}`}
              aria-pressed={selected === day.day}
              className="day-column"
              onClick={() => {
                setSelected(selected === day.day ? null : day.day);
                setHourSelection(null);
              }}
              title={`${readable(day.day)} · ${duration(day.seconds)}`}
            >
              <span className="day-bar-space">
                <span
                  className="day-bar"
                  style={{
                    height: `${day.seconds ? Math.max(1.5, (day.seconds / maximum) * 100) : 0}%`,
                  }}
                />
              </span>
              <span className="day-tick">
                {chartDays.length <= 7
                  ? new Date(day.day + "T12:00:00Z").toLocaleDateString(undefined, {
                      weekday: "short",
                      timeZone: "UTC",
                    })
                  : index % Math.ceil(chartDays.length / 7) === 0
                    ? readable(day.day)
                    : ""}
              </span>
            </button>
          ))}
        </div>
        <div className="chart-footnote">
          <span>{readable(chartDays[0].day)}</span>
          <span>
            Peak {duration(Math.max(0, ...chartDays.map((day) => day.seconds)))}/day · UTC
          </span>
          <span>{readable(chartDays.at(-1)!.day)}</span>
        </div>
      </section>
      <div className="insight-columns">
        <section className="insight-panel">
          <div className="panel-heading">
            <h2>In focus</h2>
            <div className="breakdown-tabs" aria-label="Breakdown">
              <button aria-pressed={breakdown === "apps"} onClick={() => setBreakdown("apps")}>
                Apps
              </button>
              <button
                aria-pressed={breakdown === "activities"}
                onClick={() => setBreakdown("activities")}
              >
                Activity
              </button>
            </div>
          </div>
          <Ranking
            rows={combined(filtered, breakdown)}
            total={total}
            apps={breakdown === "apps" ? catalog : undefined}
          />
        </section>
        <section className="insight-panel">
          <div className="panel-heading">
            <h2>Projects</h2>
            <span>Detected context</span>
          </div>
          <Ranking rows={combined(filtered, "projects")} total={total} />
          <p className="small-note">
            Unassigned means the capture has no project context yet. App usage alone doesn’t
            identify a project.
          </p>
        </section>
      </div>
      <section className="insight-panel">
        <div className="panel-heading">
          <h2>Day by hour</h2>
          <span>Select an hour to see its breakdown · UTC</span>
        </div>
        <div className="hour-scroll">
          <div className="hour-grid">
            <span className="hour-grid-label">UTC</span>
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="hour-grid-label">
                {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
              </span>
            ))}
            <span className="hour-grid-label">Total</span>
            {heatmapDays.map((day) => (
              <div className="hour-grid-row" key={day.day}>
                <button
                  className="quiet hour-day"
                  onClick={() => {
                    setSelected(selected === day.day ? null : day.day);
                    setHourSelection(null);
                  }}
                >
                  {readable(day.day)}
                </button>
                {Array.from({ length: 24 }, (_, hour) => {
                  const seconds = day.hours?.[hour] ?? 0;
                  return (
                    <button
                      key={hour}
                      className="hour-cell"
                      aria-label={`${readable(day.day)}, ${String(hour).padStart(2, "0")}:00 UTC: ${duration(seconds)}`}
                      aria-pressed={hourSelection?.day === day.day && hourSelection.hour === hour}
                      title={`${readable(day.day)} · ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00 UTC · ${duration(seconds)}`}
                      onClick={() => setHourSelection({ day: day.day, hour })}
                    >
                      <span
                        style={{ opacity: seconds ? 0.15 + 0.85 * Math.min(1, seconds / 3600) : 0 }}
                      />
                    </button>
                  );
                })}
                <span className="hour-day-total">{duration(day.seconds)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="hour-legend">
          <span>
            {!selected && chartDays.length > 14 ? "Most recent 14 days" : "Each square is one hour"}
          </span>
          <span>
            0 min <i /> 60 min
          </span>
        </div>
        {hourSelection && (
          <div className="hour-detail" aria-live="polite">
            <div className="panel-heading">
              <h3>
                {readable(hourSelection.day)} · {String(hourSelection.hour).padStart(2, "0")}:00–
                {String(hourSelection.hour + 1).padStart(2, "0")}:00 UTC
              </h3>
              <button className="quiet" onClick={() => setHourSelection(null)}>
                Close hourly breakdown
              </button>
            </div>
            <p className="hour-detail-total">
              {duration(hourDetail?.seconds ?? hourDay?.hours?.[hourSelection.hour] ?? 0)} estimated
              {hourDetail && ` · ${hourDetail.captures} captures`}
            </p>
            {hourDetail?.seconds ? (
              <>
                <div className="insight-columns">
                  <div>
                    <h4>Apps in focus</h4>
                    <Ranking rows={hourDetail.apps} total={hourDetail.seconds} apps={catalog} />
                  </div>
                  <div>
                    <h4>Activity</h4>
                    <Ranking rows={hourDetail.activities} total={hourDetail.seconds} />
                  </div>
                </div>
                <p className="small-note">
                  Projects:{" "}
                  {hourDetail.projects
                    .map((row) => `${row.name} (${duration(row.seconds)})`)
                    .join(" · ")}
                </p>
              </>
            ) : (
              <p className="muted">
                {(hourDay?.hours?.[hourSelection.hour] ?? 0) > 0
                  ? "Hourly details are still being indexed."
                  : "No activity was sampled during this hour."}
              </p>
            )}
          </div>
        )}
      </section>
      <p className="small-note">
        Estimated from capture spacing, with long gaps excluded. Visible context isn’t verified
        attention or productive time. Background apps aren’t added to focused time.
      </p>
    </>
  );
}
