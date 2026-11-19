"use client";
import { useEffect, useState } from "react";
import { duration, type Breakdown, type InsightDay } from "../lib/insights";
import { appSeed, findApp, mergeApps, type AppEntry } from "../lib/apps";
import { AppIcon } from "./app-icon";
import { ActivityIcon } from "./activity-icon";

function combined(
  days: InsightDay[],
  key: "apps" | "activities" | "projects",
  catalog: AppEntry[] = appSeed,
): Breakdown {
  const totals = new Map<string, Breakdown[number]>();
  for (const day of days)
    for (const item of day[key] ?? [
      { name: key === "projects" ? "Unassigned" : "Not indexed yet", seconds: day.seconds },
    ]) {
      const key = item.id || item.name;
      totals.set(key, { ...item, seconds: (totals.get(key)?.seconds ?? 0) + item.seconds });
    }
  const rows = [...totals.values()];
  return key === "apps" ? mergeApps(rows, catalog) : rows.sort((a, b) => b.seconds - a.seconds);
}
function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}
function Ranking({
  rows,
  total,
  apps,
  project = false,
  loading = false,
}: {
  rows: Breakdown;
  total: number;
  apps?: AppEntry[];
  project?: boolean;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = expanded ? Math.max(6, rows.length) : 6;
  const more = !loading && rows.length > 6;
  return (
    <div className="ranking">
      <div className="ranking-list" aria-hidden={loading || undefined}>
        {/* Each DOM row is a fixed rank slot, so live reordering never moves its box. */}
        {Array.from({ length: count }, (_, index) => {
          const row = loading ? undefined : rows[index];
          return (
            <div
              className={`rank-row ${!loading && !row ? "rank-slot-empty" : ""}`}
              key={index}
              aria-hidden={!row || undefined}
            >
              <span className="rank-name" title={row?.name}>
                {!row ? (
                  <>
                    <Skeleton className="skeleton-icon" />
                    <Skeleton className="skeleton-name" />
                  </>
                ) : (
                  <>
                    {apps ? (
                      <AppIcon apps={apps} name={row.name} id={row.id} />
                    ) : (
                      <ActivityIcon name={row.name} project={project} />
                    )}
                    {apps ? findApp(apps, row.name, row.id)?.name || row.name : row.name}
                  </>
                )}
              </span>
              <strong>
                {row ? duration(row.seconds) : <Skeleton className="skeleton-time" />}
              </strong>
              <span className="rank-percent">
                {row ? (
                  `${total ? Math.round((row.seconds / total) * 100) : 0}%`
                ) : (
                  <Skeleton className="skeleton-percent" />
                )}
              </span>
              <span className="rank-track">
                <span
                  className={loading ? "skeleton" : undefined}
                  style={{
                    transform: `scaleX(${row && total ? row.seconds / total : loading ? 0.3 + (index % 3) * 0.15 : 0})`,
                  }}
                />
              </span>
            </div>
          );
        })}
        {!loading && !rows.length && (
          <p className="muted ranking-empty">No sampled activity in this range.</p>
        )}
      </div>
      <div className="ranking-more">
        <button
          className="quiet show-all"
          style={{ visibility: more ? "visible" : "hidden" }}
          disabled={!more}
          aria-hidden={!more}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : `Show all ${rows.length}`}
        </button>
      </div>
    </div>
  );
}
export function TimeDashboard({
  days,
  loading = false,
}: {
  days: InsightDay[];
  loading?: boolean;
}) {
  const [range, setRange] = useState("7"),
    [selected, setSelected] = useState<string | null>(null),
    [hourSelection, setHourSelection] = useState<{ day: string; hour: number } | null>(null),
    [catalog, setCatalog] = useState<AppEntry[]>(appSeed),
    [catalogReady, setCatalogReady] = useState(false),
    [breakdown, setBreakdown] = useState<"apps" | "activities">("apps");
  const today = new Date().toISOString().slice(0, 10);
  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch("/api/apps", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (Array.isArray(value?.apps) && !controller.signal.aborted) setCatalog(value.apps);
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        if (mounted) setCatalogReady(true);
      });
    return () => {
      mounted = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);
  const pending = loading || !catalogReady;
  const end = Date.parse(today);
  const cutoff = range === "all" ? -Infinity : end - (Number(range) - 1) * 86400000;
  const period = days
    .filter((day) => Date.parse(day.day) >= cutoff && Date.parse(day.day) <= end)
    .sort((a, b) => a.day.localeCompare(b.day));
  const filtered = selected ? period.filter((day) => day.day === selected) : period;
  const total = filtered.reduce((sum, day) => sum + day.seconds, 0);
  const captures = filtered.reduce((sum, day) => sum + day.captures, 0);
  const apps = combined(filtered, "apps", catalog);
  const chartDays: InsightDay[] = [];
  const start = range === "all" ? end - 89 * 86400000 : cutoff;
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
    <div className="time-dashboard" aria-busy={pending}>
      <span className="sr-only" role="status">
        {pending ? "Loading time dashboard…" : ""}
      </span>
      <div className="insights-toolbar">
        <div>
          <h1>Where your time went</h1>
          <p className="muted">A little perspective on your days.</p>
        </div>
        <select
          aria-label="Time range"
          value={range}
          disabled={pending}
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
          <strong>{pending ? <Skeleton className="skeleton-metric" /> : duration(total)}</strong>
          <small>
            {pending ? (
              <Skeleton className="skeleton-caption" />
            ) : selected ? (
              readable(selected)
            ) : (
              `${filtered.filter((day) => day.seconds > 0).length} active days`
            )}
          </small>
        </div>
        <div>
          <span>Most used app</span>
          <strong className="stat-app" title={apps[0]?.name}>
            {pending ? (
              <Skeleton className="skeleton-metric" />
            ) : apps[0] ? (
              findApp(catalog, apps[0].name, apps[0].id)?.name || apps[0].name
            ) : (
              "—"
            )}
          </strong>
          <small>
            {pending ? (
              <Skeleton className="skeleton-caption" />
            ) : apps[0] ? (
              duration(apps[0].seconds)
            ) : (
              "Waiting for captures"
            )}
          </small>
        </div>
        <div>
          <span>Captures synced</span>
          <strong>
            {pending ? <Skeleton className="skeleton-metric" /> : captures.toLocaleString()}
          </strong>
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
          style={{
            gridTemplateColumns: `repeat(${chartDays.length}, minmax(0,1fr))`,
            columnGap: chartDays.length > 7 ? 2 : 6,
          }}
        >
          {chartDays.map((day, index) => (
            <button
              key={index}
              aria-label={`${readable(day.day)}: ${duration(day.seconds)}`}
              aria-pressed={selected === day.day}
              className="day-column"
              disabled={pending}
              onClick={() => {
                setSelected(selected === day.day ? null : day.day);
                setHourSelection(null);
              }}
              title={`${readable(day.day)} · ${duration(day.seconds)}`}
            >
              <span className="day-bar-space">
                <span
                  className={`day-bar ${pending ? "skeleton" : ""}`}
                  style={{
                    transform: `scaleY(${pending ? 0.3 + (index % 4) * 0.15 : day.seconds ? Math.max(0.015, day.seconds / maximum) : 0})`,
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
            {pending ? (
              <Skeleton className="skeleton-caption" />
            ) : (
              <>Peak {duration(Math.max(0, ...chartDays.map((day) => day.seconds)))}/day · UTC</>
            )}
          </span>
          <span>{readable(chartDays.at(-1)!.day)}</span>
        </div>
        {!pending && !captures && (
          <div className="empty-chart">
            <h3>Connect your desktop</h3>
            <p>
              In Breadcrumb, open Settings → Account. Enter this portal’s URL and sign in to start
              syncing.
            </p>
          </div>
        )}
      </section>
      <div className="insight-columns">
        <section className="insight-panel ranking-panel">
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
            rows={combined(filtered, breakdown, catalog)}
            total={total}
            apps={breakdown === "apps" ? catalog : undefined}
            loading={pending}
          />
        </section>
        <section className="insight-panel ranking-panel">
          <div className="panel-heading">
            <h2>Projects</h2>
            <span>Detected context</span>
          </div>
          <Ranking rows={combined(filtered, "projects")} total={total} project loading={pending} />
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
        <div className="hour-scroll" style={{ height: range === "7" ? 220 : 340 }}>
          <div className="hour-grid">
            <span className="hour-grid-label">UTC</span>
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="hour-grid-label">
                {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
              </span>
            ))}
            <span className="hour-grid-label">Total</span>
            {heatmapDays.map((day, index) => (
              <div className="hour-grid-row" key={index}>
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
                      disabled={pending}
                      aria-label={`${readable(day.day)}, ${String(hour).padStart(2, "0")}:00 UTC: ${duration(seconds)}`}
                      aria-pressed={hourSelection?.day === day.day && hourSelection.hour === hour}
                      title={`${readable(day.day)} · ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00 UTC · ${duration(seconds)}`}
                      onClick={() => setHourSelection({ day: day.day, hour })}
                    >
                      <span
                        className={pending ? "skeleton" : undefined}
                        style={{
                          opacity: pending
                            ? 1
                            : seconds
                              ? 0.15 + 0.85 * Math.min(1, seconds / 3600)
                              : 0,
                        }}
                      />
                    </button>
                  );
                })}
                <span className="hour-day-total">
                  {pending ? <Skeleton className="skeleton-time" /> : duration(day.seconds)}
                </span>
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
            <div className="insight-columns hour-rankings">
              <div className="hour-ranking">
                <h4>Apps in focus</h4>
                <Ranking
                  rows={mergeApps(hourDetail?.apps ?? [], catalog)}
                  total={hourDetail?.seconds ?? 0}
                  apps={catalog}
                  loading={!hourDetail && (hourDay?.hours?.[hourSelection.hour] ?? 0) > 0}
                />
              </div>
              <div className="hour-ranking">
                <h4>Activity</h4>
                <Ranking
                  rows={hourDetail?.activities ?? []}
                  total={hourDetail?.seconds ?? 0}
                  loading={!hourDetail && (hourDay?.hours?.[hourSelection.hour] ?? 0) > 0}
                />
              </div>
            </div>
            <p className="small-note hour-projects">
              Projects:{" "}
              {hourDetail?.projects
                .map((row) => `${row.name} (${duration(row.seconds)})`)
                .join(" · ") || "No detected project context in this hour."}
            </p>
          </div>
        )}
      </section>
      <p className="small-note">
        Estimated from capture spacing, with long gaps excluded. Visible context isn’t verified
        attention or productive time. Background apps aren’t added to focused time.
      </p>
    </div>
  );
}
