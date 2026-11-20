"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  duration,
  calendarClock,
  REFERENCE,
  type Breakdown,
  type InsightDay,
} from "../lib/insights";
import { appSeed, findApp, mergeApps, type AppEntry } from "../lib/apps";
import { AppIcon } from "./app-icon";
import { activityName, activityDescription } from "../lib/activities";
import { ActivityIcon } from "./activity-icon";

const timeRanges = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "all", label: "All time" },
];
function TimeRange({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div
      className="time-range"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
        ];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      <button
        ref={trigger}
        className="time-range-trigger"
        aria-label="Time range"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        {timeRanges.find((item) => item.value === value)?.label}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="time-range-menu" id={id} role="menu" aria-label="Time range">
          {timeRanges.map((item) => (
            <button
              key={item.value}
              role="menuitemradio"
              aria-checked={value === item.value}
              tabIndex={-1}
              onClick={() => {
                onChange(item.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{item.label}</span>
              <span aria-hidden="true">{value === item.value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function combined(
  days: Pick<InsightDay, "seconds" | "apps" | "activities" | "projects">[],
  key: "apps" | "activities" | "projects",
  catalog: AppEntry[] = appSeed,
): Breakdown {
  const totals = new Map<string, Breakdown[number]>();
  for (const day of days)
    for (const item of day[key] ?? [
      { name: key === "projects" ? "Unassigned" : "Not indexed yet", seconds: day.seconds },
    ]) {
      const name = key === "activities" ? activityName(item.name) : item.name;
      const id = item.id || name;
      totals.set(id, { ...item, name, seconds: (totals.get(id)?.seconds ?? 0) + item.seconds });
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
  onSelect,
}: {
  onSelect?: (name: string) => void;
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
          const Row = row && onSelect ? "button" : "div";
          return (
            <Row
              title={row && onSelect ? activityDescription(row.name) : undefined}
              onClick={row && onSelect ? () => onSelect(row.name) : undefined}
              aria-label={row && onSelect ? `Explore ${row.name}` : undefined}
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
            </Row>
          );
        })}
        {!loading && !rows.length && (
          <p className="muted ranking-empty">No sampled activity in this range.</p>
        )}
      </div>
      <div className="ranking-more">
        {onSelect && <span className="muted">Select a category to explore</span>}
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
function ActivityExplorer({
  name,
  days,
  catalog,
  onClose,
  onDay,
}: {
  name: string;
  days: InsightDay[];
  catalog: AppEntry[];
  onClose: () => void;
  onDay: (day: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  const points = days.map((day) => ({
    day: day.day,
    seconds: (day.activities ?? [])
      .filter((row) => activityName(row.name) === name)
      .reduce((n, row) => n + row.seconds, 0),
    detail: Object.entries(day.activityDetails ?? {})
      .filter(([key]) => activityName(key) === name)
      .map(([, value]) => value),
  }));
  const total = points.reduce((n, point) => n + point.seconds, 0);
  const indexed = points.flatMap((point) => point.detail);
  const join = (key: "apps" | "projects") => combined(indexed, key, catalog);
  const peak = Math.max(1, ...points.map((point) => point.seconds));
  const covered = indexed.reduce((n, value) => n + value.seconds, 0);
  return (
    <dialog
      ref={dialog}
      className="activity-dialog"
      aria-labelledby="activity-title"
      onClose={() => {
        if (dialog.current && !dialog.current.open) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header className="activity-dialog-heading">
        <div>
          <ActivityIcon name={name} />
          <h2 id="activity-title">{name}</h2>
        </div>
        <button className="quiet" onClick={onClose} aria-label="Close activity details">
          ✕
        </button>
      </header>
      <p className="muted">{activityDescription(name)}</p>
      <div className="activity-total">
        <strong>{duration(total)}</strong>
        <span>estimated · {points.filter((point) => point.seconds > 0).length} active days</span>
      </div>
      <h3>Daily breakdown</h3>
      <p className="muted">Select a day to explore it on your dashboard.</p>
      <div className="activity-days">
        {points.map((point) => (
          <button
            key={point.day}
            onClick={() => onDay(point.day)}
            disabled={!point.seconds}
            aria-label={`Explore ${name} on ${point.day}: ${duration(point.seconds)}`}
            title={`${point.day} · ${duration(point.seconds)}`}
          >
            <span className="activity-day-space">
              <span style={{ height: `${Math.max(2, (point.seconds / peak) * 100)}%` }} />
            </span>
            <small>{point.day.slice(5)}</small>
          </button>
        ))}
      </div>
      {covered < total - 1 && (
        <p className="small-note">
          App and project details cover {duration(covered)} of {duration(total)} while older
          captures are indexed.
        </p>
      )}
      <div className="insight-columns">
        <section className="ranking-panel">
          <h3>Apps used</h3>
          <Ranking rows={join("apps")} total={covered} apps={catalog} />
        </section>
        <section className="ranking-panel">
          <h3>Projects</h3>
          <Ranking rows={join("projects")} total={covered} project />
        </section>
      </div>
      <p className="small-note">
        Estimated from focused-window context. Visible content does not establish attention or
        productive work. Background apps are not added to this time.
      </p>
    </dialog>
  );
}
export function TimeDashboard({
  days,
  loading = false,
  timeZone = "UTC",
  local = false,
}: {
  days: InsightDay[];
  loading?: boolean;
  timeZone?: string;
  local?: boolean;
}) {
  const [activity, setActivity] = useState<string | null>(null);
  const [range, setRange] = useState("7"),
    [selected, setSelected] = useState<string | null>(null),
    [hourSelection, setHourSelection] = useState<{ day: string; hour: number } | null>(null),
    [catalog, setCatalog] = useState<AppEntry[]>(appSeed),
    [catalogReady, setCatalogReady] = useState(false),
    [breakdown, setBreakdown] = useState<"apps" | "activities">("apps");
  const today = calendarClock(timeZone)(Date.now() / 1000 - REFERENCE).day;
  const zoneLabel = timeZone === "UTC" ? "UTC" : "Local time";
  useEffect(() => {
    if (local) return;
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
  }, [local]);
  const pending = loading || (!local && !catalogReady);
  const end = Date.parse(today);
  const cutoff = range === "all" ? -Infinity : end - (Number(range) - 1) * 86400000;
  const period = days
    .filter((day) => Date.parse(day.day) >= cutoff && Date.parse(day.day) <= end)
    .sort((a, b) => a.day.localeCompare(b.day));
  const filtered = selected ? period.filter((day) => day.day === selected) : period;
  const total = filtered.reduce((sum, day) => sum + day.seconds, 0);
  const captures = filtered.reduce((sum, day) => sum + day.captures, 0);
  const first = Math.min(
    ...filtered.flatMap((day) => (day.firstCapture == null ? [] : [day.firstCapture])),
  );
  const last = Math.max(
    ...filtered.flatMap((day) => (day.lastCapture == null ? [] : [day.lastCapture])),
  );
  const span = Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null;
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
      {activity && (
        <ActivityExplorer
          name={activity}
          days={filtered}
          catalog={catalog}
          onClose={() => setActivity(null)}
          onDay={(day) => {
            setSelected(day);
            setHourSelection(null);
            setActivity(null);
          }}
        />
      )}
      <span className="sr-only" role="status">
        {pending ? "Loading time dashboard…" : ""}
      </span>
      <div className="insights-toolbar">
        <div>
          <h1>Where your time went</h1>
          <p className="muted">A little perspective on your days.</p>
        </div>
        <TimeRange
          value={range}
          disabled={pending}
          onChange={(value) => {
            setRange(value);
            setSelected(null);
            setHourSelection(null);
          }}
        />
      </div>
      <div className="insight-stats">
        <div>
          <span>Observed time</span>
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
              <>
                <AppIcon apps={catalog} name={apps[0].name} id={apps[0].id} />
                <span className="stat-app-name">
                  {findApp(catalog, apps[0].name, apps[0].id)?.name || apps[0].name}
                </span>
              </>
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
              <span className="day-tick" style={{ visibility: pending ? "hidden" : undefined }}>
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
              <>
                Peak {duration(Math.max(0, ...chartDays.map((day) => day.seconds)))}/day ·{" "}
                {zoneLabel}
              </>
            )}
          </span>
          <span>{readable(chartDays.at(-1)!.day)}</span>
        </div>
        {!pending && !captures && (
          <div className="empty-chart">
            <h3>{local ? "Your history starts here" : "Connect your desktop"}</h3>
            <p>
              {local
                ? "Start recording in Breadcrumb. Your activity will appear here without signing in or uploading anything."
                : "In Breadcrumb, open Settings → Account. Enter this portal’s URL and sign in to start syncing."}
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
            onSelect={breakdown === "activities" ? setActivity : undefined}
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
          <span title={timeZone}>Select an hour to see its breakdown · {zoneLabel}</span>
        </div>
        <div className="hour-scroll" style={{ height: range === "7" ? 220 : 340 }}>
          <div className="hour-grid">
            <span className="hour-grid-label" title={timeZone}>
              {zoneLabel === "UTC" ? "UTC" : "Local"}
            </span>
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
                  const seconds = day.hourly?.[hour]?.seconds ?? day.hours?.[hour] ?? 0;
                  return (
                    <button
                      key={hour}
                      className={`hour-cell${pending ? " skeleton" : ""}`}
                      style={
                        pending
                          ? undefined
                          : {
                              background: `color-mix(in srgb, var(--accent) ${seconds ? 15 + 85 * Math.min(1, seconds / 3600) : 0}%, var(--track))`,
                            }
                      }
                      disabled={pending}
                      aria-label={`${readable(day.day)}, ${String(hour).padStart(2, "0")}:00 ${zoneLabel}: ${duration(seconds)}`}
                      aria-pressed={hourSelection?.day === day.day && hourSelection.hour === hour}
                      title={`${readable(day.day)} · ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00 ${zoneLabel} · ${duration(seconds)}`}
                      onClick={() => setHourSelection({ day: day.day, hour })}
                    ></button>
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
                {String(hourSelection.hour + 1).padStart(2, "0")}:00 {zoneLabel}
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
      <div className="coverage-strip" aria-label="History coverage">
        {[
          ["History span", span == null ? "—" : duration(span)],
          ["Without samples", span == null ? "—" : duration(Math.max(0, span - total))],
          ["Coverage", span ? `${Math.min(100, Math.round((total / span) * 100))}%` : "—"],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{pending ? <Skeleton className="skeleton-time" /> : value}</strong>
          </div>
        ))}
      </div>
      <p className="small-note">
        History span runs from the first to the last capture in this range. Observed time estimates
        sampled coverage; gaps can include sleep, pauses, or excluded apps. Visible context does not
        establish attention or productive work. Background apps are not added to focused time.
      </p>
    </div>
  );
}
