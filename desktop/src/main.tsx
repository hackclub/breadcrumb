import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SyncProgress } from "./sync-progress";
import { SyncPage } from "./sync-page";
import { engine, isNative, hidePanel, withPanelDialog, confirmAction, onPanelOpen } from "./bridge";
import {
  activities,
  activity,
  bytes,
  date,
  shortActivity,
  timestamp,
  type Payload,
  type Settings,
  type State,
} from "./types";
import { Icon } from "./icons";
import { AppIcon } from "./app-icon";
import { estimateTimeline, estimatedTime, sessionContext } from "./activity";
import { SlidingPanels } from "./sliding-panels";
import { ThemePicker } from "./theme-picker";
import { applyTheme, readTheme } from "../../web/lib/theme";
import "./style.css";
const time = (v: number) => date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
applyTheme(readTheme());
function App() {
  const [state, setState] = useState<State | null>(null),
    [tab, setTab] = useState("history"),
    [compact, setCompact] = useState(true),
    [activityRange, setActivityRange] = useState("all"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [payload, setPayload] = useState<Payload | null>(null),
    [filter, setFilter] = useState<string[] | null>(null),
    [filterName, setFilterName] = useState(""),
    [name, setName] = useState(""),
    [rangeStart, setRangeStart] = useState(""),
    [rangeEnd, setRangeEnd] = useState("");
  function overview() {
    setCompact(true);
    setSelected("");
    setFilter(null);
    setFilterName("");
  }
  function expand(destination = "history") {
    setCompact(false);
    setTab(destination);
  }
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void onPanelOpen(overview).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
  async function refresh() {
    try {
      setState(await engine("state"));
    } catch (e) {
      setMessage(String(e));
    }
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void hidePanel();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (isNative || !document.hidden) void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(
    () => state?.observations.filter((r) => !filter || filter.includes(r.id)) ?? [],
    [state, filter],
  );
  const current = rows.find((r) => r.id === selected) ?? rows.at(-1);
  useEffect(() => {
    if (!current) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setPayload(null);
    engine<Payload>("payload", { id: current.id })
      .then((p) => {
        if (!cancelled) setPayload(p);
      })
      .catch((e) => {
        if (!cancelled) setMessage(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id]);
  async function action(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      if (success) setMessage(success);
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  function history(ids: string[] | null, title = "") {
    setFilter(ids);
    setFilterName(title);
    setSelected("");
    setTab("history");
  }
  const estimates = useMemo(
    () => estimateTimeline(state?.observations ?? []),
    [state?.observations],
  );
  const recordsByID = useMemo(
    () => new Map((state?.observations ?? []).map((row) => [row.id, row])),
    [state?.observations],
  );
  const sessionDetails = useMemo(
    () =>
      new Map(
        (state?.sessions ?? []).map((session) => [
          session.id,
          sessionContext(session, recordsByID, estimates),
        ]),
      ),
    [state?.sessions, recordsByID, estimates],
  );
  const activitySummary = useMemo(() => {
    const now = new Date();
    const start =
      activityRange === "today"
        ? timestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
        : activityRange === "week"
          ? timestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6))
          : -Infinity;
    return activityRange === "all"
      ? estimates
      : estimateTimeline(state?.observations ?? [], timestamp(now), start);
  }, [activityRange, estimates, state?.observations]);
  if (!state)
    return (
      <main className="loading">
        <Icon name="crumbs" size={28} />
        <h1>Breadcrumb</h1>
        <p>Opening your local history…</p>
        {message && <p role="alert">{message}</p>}
      </main>
    );
  return (
    <div className={compact ? "desktop compact-panel" : "desktop"}>
      <main className="workspace">
        <header className="topbar" data-tauri-drag-region>
          <div className="app-heading" data-tauri-drag-region>
            {!compact && (
              <button
                className="icon-button back-button"
                aria-label="Back to overview"
                title="Back"
                onClick={overview}
              >
                <Icon name="back" />
              </button>
            )}
            <h1
              key={compact ? "overview" : tab}
              className="view-heading"
              data-tauri-drag-region
              title={filterName || undefined}
            >
              {compact
                ? "Breadcrumb"
                : tab === "settings"
                  ? "Settings"
                  : tab === "sync"
                    ? "Sync"
                    : tab === "history"
                      ? filterName || "History"
                      : tab === "sessions"
                        ? "Sessions"
                        : tab === "saved"
                          ? "Saved clips"
                          : "Activity"}
            </h1>
            <div className="record-status" title={state.status}>
              <i className={state.recording ? "live" : ""} />
              <span className={compact ? "" : "sr-only"}>
                {state.recording ? "Recording" : "Paused"}
              </span>
              {state.demo && <b>Demo</b>}
            </div>
          </div>
          <div className="actions">
            <button
              className="icon-button"
              title={state.recording ? "Pause recording" : "Start recording"}
              disabled={busy || state.demo}
              aria-label={state.recording ? "Pause recording" : "Start recording"}
              onClick={() => action(() => engine("toggle"))}
            >
              <Icon name={state.recording ? "pause" : "play"} />
            </button>
            <button
              className={!compact && tab === "settings" ? "icon-button selected" : "icon-button"}
              aria-label="Settings"
              title="Settings"
              onClick={() => expand("settings")}
            >
              <Icon name="settings" />
            </button>
            <button
              className="icon-button"
              aria-label="Hide to menu bar"
              title="Hide to menu bar"
              disabled={!isNative}
              onClick={() => void hidePanel()}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <nav
          hidden={compact || tab === "settings" || tab === "sync"}
          className="panel-nav"
          aria-label="Main navigation"
        >
          {[
            ["history", "History"],
            ["sessions", "Sessions"],
            ["saved", "Saved"],
            ["activity", "Activity"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              className={tab === id ? "selected" : ""}
              onClick={() => {
                setTab(id);
                if (id === "history") {
                  setFilter(null);
                  setFilterName("");
                }
              }}
            >
              {label}
              {id === "saved" && state.clips.length > 0 && <small>{state.clips.length}</small>}
            </button>
          ))}
        </nav>
        {message && (
          <div className="notice" role="status">
            <span>{message}</span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setMessage("")}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <SlidingPanels view={compact ? "overview" : tab}>
          {compact && (
            <section className="quick-panel" aria-label="Recording overview">
              <div className="quick-preview">
                {payload && current ? (
                  <img
                    src={`data:image/jpeg;base64,${payload.jpeg}`}
                    alt={`Latest desktop capture from ${current.app}`}
                  />
                ) : (
                  <span className="preview-placeholder">
                    <Icon name="image" size={22} />
                    {current ? "Loading capture…" : "Your history starts here"}
                    {!current && (
                      <small>
                        Screenshots and app context stay on this device. Press Start to begin.
                      </small>
                    )}
                  </span>
                )}
              </div>
              <div className="quick-caption">
                <strong>{current?.app || "No captures yet"}</strong>
                <time title={current ? date(current.date).toLocaleString() : undefined}>
                  {current
                    ? (() => {
                        const age = Math.max(0, (Date.now() - date(current.date).getTime()) / 1000);
                        return age < 60
                          ? "Just captured"
                          : age < 3600
                            ? `${Math.floor(age / 60)}m ago`
                            : age < 86400
                              ? `${Math.floor(age / 3600)}h ago`
                              : date(current.date).toLocaleDateString([], {
                                  month: "short",
                                  day: "numeric",
                                });
                      })()
                    : ""}
                </time>
              </div>
              <p className="quick-title">
                {current?.windowTitle || "Start recording, then return to another app."}
              </p>
              {state.capabilities.permission === "required" && (
                <button className="outline compact" onClick={() => expand("settings")}>
                  Allow Screen Recording
                </button>
              )}
              {state.sync && (state.connected || state.sync.enabled) && (
                <button
                  className="sync-status quiet"
                  aria-label="Open sync details"
                  onClick={() => expand("sync")}
                >
                  <SyncProgress sync={state.sync} />
                </button>
              )}
              <div className="quick-actions">
                <button
                  className="primary-action"
                  disabled={busy || !state.observations.length}
                  onClick={() =>
                    action(
                      () =>
                        engine("save", {
                          name: "Last hour",
                          start: timestamp(new Date(Date.now() - 3600000)),
                          end: timestamp(new Date()),
                        }),
                      "Last hour saved.",
                    )
                  }
                >
                  <Icon name="save" />
                  Save last hour
                </button>
                <button className="history-link" aria-label="Open history" onClick={() => expand()}>
                  <span>
                    <Icon name="history" />
                    History
                  </span>
                  <span className="history-count">
                    <span
                      title={`${state.observations.length.toLocaleString()} captures; estimated from capture spacing, with gaps excluded.`}
                    >
                      {estimatedTime(estimates.seconds)} observed
                    </span>
                    <Icon name="chevron" size={14} />
                  </span>
                </button>
              </div>
            </section>
          )}
          {!compact && tab === "history" && (
            <section className="page">
              <div className="page-title">
                <div>
                  <p>
                    {rows.length} captures
                    {state.settings.retentionHours === 0 ? " · kept until you delete them" : ""}
                  </p>
                </div>
                <div className="actions">
                  {filter && (
                    <button className="quiet" onClick={() => history(null)}>
                      All history
                    </button>
                  )}
                  <button
                    disabled={busy || !state.observations.length}
                    onClick={() =>
                      action(
                        () =>
                          engine("save", {
                            name: "Last hour",
                            start: timestamp(new Date(Date.now() - 3600000)),
                            end: timestamp(new Date()),
                          }),
                        "Last hour saved.",
                      )
                    }
                  >
                    Save last hour
                  </button>
                </div>
              </div>
              {!state.demo && !state.capabilities.screenshot && (
                <div className="card">
                  <h2>Native capture is not ready</h2>
                  <p>{state.status}</p>
                </div>
              )}
              {state.capabilities.permission === "required" && (
                <div className="permission">
                  <div>
                    <strong>Allow screen recording</strong>
                    <p>
                      Enable Breadcrumb in system settings. Accessibility adds window and document
                      context.
                    </p>
                  </div>
                  <button onClick={() => action(() => engine("permissions"))}>
                    Open permissions
                  </button>
                </div>
              )}
              {current ? (
                <>
                  <div className="preview" aria-label="Capture preview">
                    {payload ? (
                      <img
                        src={"data:image/jpeg;base64," + payload.jpeg}
                        alt={`Desktop capture from ${current.app} at ${time(current.date)}`}
                      />
                    ) : (
                      <span>Loading capture…</span>
                    )}
                    <span className="preview-badge">{time(current.date)}</span>
                  </div>
                  <div className="capture-caption">
                    <div>
                      <strong>{current.app}</strong>
                      <span>{current.windowTitle}</span>
                    </div>
                    <span className="pill">{shortActivity(activity(current))}</span>
                  </div>
                  <div className="scrubber">
                    <input
                      aria-label="Capture timeline"
                      type="range"
                      min="0"
                      max={Math.max(0, rows.length - 1)}
                      value={Math.max(
                        0,
                        rows.findIndex((r) => r.id === current.id),
                      )}
                      onChange={(e) => setSelected(rows[Number(e.target.value)].id)}
                    />
                    <div>
                      <span>{time(rows[0].date)}</span>
                      <span>
                        {rows.findIndex((r) => r.id === current.id) + 1} of {rows.length}
                      </span>
                      <span>{time(rows.at(-1)!.date)}</span>
                    </div>
                  </div>
                  <div className="context-grid">
                    <div className="card context">
                      <div className="context-label">In focus</div>
                      <h3>{current.context?.project || current.context?.domain || current.app}</h3>
                      <p>{current.context?.document || current.windowTitle}</p>
                    </div>
                    <div className="card context">
                      <div className="context-label">Alongside</div>
                      {current.visibleWindows?.filter((w) => !w.focused).length ? (
                        current.visibleWindows
                          .filter((w) => !w.focused)
                          .slice(0, 3)
                          .map((w) => (
                            <div className="alongside" key={w.windowID}>
                              <strong>{w.app}</strong>
                              <span>{w.title}</span>
                            </div>
                          ))
                      ) : (
                        <p>No alongside window context was available.</p>
                      )}
                      <small>Visibility doesn’t establish playback or attention.</small>
                    </div>
                  </div>
                  <details className="card details">
                    <summary>Save a time range</summary>
                    <div className="range-fields">
                      <label>
                        Clip name
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="What were you working on?"
                        />
                      </label>
                      <label>
                        From
                        <input
                          type="datetime-local"
                          value={rangeStart}
                          onChange={(e) => setRangeStart(e.target.value)}
                        />
                      </label>
                      <label>
                        To
                        <input
                          type="datetime-local"
                          value={rangeEnd}
                          onChange={(e) => setRangeEnd(e.target.value)}
                        />
                      </label>
                    </div>
                    <button
                      disabled={busy || !name || !rangeStart || !rangeEnd}
                      onClick={() =>
                        action(
                          () =>
                            engine("save", {
                              name,
                              start: timestamp(new Date(rangeStart)),
                              end: timestamp(new Date(rangeEnd)),
                            }),
                          "Clip saved.",
                        )
                      }
                    >
                      Save clip
                    </button>
                  </details>
                  <details className="card details">
                    <summary>Labels & captured context</summary>
                    <label>
                      Activity label
                      <select
                        value={current.correction || ""}
                        onChange={(e) =>
                          action(() =>
                            engine("correct", { id: current.id, activity: e.target.value }),
                          )
                        }
                      >
                        <option value="">Use suggested label</option>
                        {activities.map((a) => (
                          <option key={a} value={a}>
                            {shortActivity(a)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>{current.classification?.reason}</p>
                    <details>
                      <summary>{current.treeStatus || "Accessibility tree"}</summary>
                      <pre>
                        {payload?.tree
                          .map(
                            (n) => "  ".repeat(n.depth) + n.role + (n.label ? " · " + n.label : ""),
                          )
                          .join("\n") || "No accessibility tree available."}
                      </pre>
                    </details>
                    <details>
                      <summary>Extracted screen text</summary>
                      <pre>{payload?.screenText || "No OCR text available."}</pre>
                    </details>
                  </details>
                  <div className="card details">
                    <p>
                      {state.sync?.enabled
                        ? "This capture is queued for automatic sync or has already synced."
                        : "Sign in to sync your history across devices."}
                    </p>
                    <button className="quiet" onClick={() => expand("settings")}>
                      Account & sync
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty">
                  <Icon name="history" size={24} />
                  <h2>Your history starts here.</h2>
                  <p>
                    Start recording, then return to another app. Your desktop will appear here as
                    you work.
                  </p>
                </div>
              )}
            </section>
          )}
          {!compact && tab === "sessions" && (
            <section className="page">
              <PageTitle title="Sessions" text="Related captures, grouped by task and context." />
              {[...state.sessions].reverse().map((session, index, list) => {
                const details = sessionDetails.get(session.id)!;
                const primary = details.focused[0];
                const group = sessionDay(session.start);
                const showDay = index === 0 || group !== sessionDay(list[index - 1].start);
                return (
                  <React.Fragment key={session.id}>
                    {showDay && <h2 className="session-day">{group}</h2>}
                    <button
                      className="session session-rich"
                      onClick={() => history(session.ids, details.title)}
                    >
                      <div className="session-main">
                        <AppIcon
                          app={primary?.app || details.title}
                          bundleID={primary?.bundleID || ""}
                          size={30}
                        />
                        <div className="session-copy">
                          <div className="session-heading">
                            <h3>{details.title}</h3>
                            <span className="session-duration" title="Estimated time in focus">
                              {estimatedTime(details.seconds)}
                            </span>
                          </div>
                          {details.windowTitle && details.windowTitle !== details.title && (
                            <p className="session-window" title={details.windowTitle}>
                              {details.windowTitle}
                            </p>
                          )}
                          <div className="session-period">
                            {sessionTime(session.start, session.end)} · {details.captures}{" "}
                            {details.captures === 1 ? "capture" : "captures"}
                          </div>
                        </div>
                        <Icon name="chevron" size={14} />
                      </div>
                      <div className="session-focus">
                        <span className="context-key">In focus</span>
                        <span>
                          {details.focused
                            .slice(0, 3)
                            .map((app) => app.app)
                            .join(", ")}
                        </span>
                        <span className="pill">{details.activity}</span>
                      </div>
                      {details.alongside.length > 0 && (
                        <div className="session-alongside">
                          <span className="context-key">Alongside</span>
                          <span className="alongside-apps">
                            {details.alongside.slice(0, 3).map((app) => (
                              <span
                                key={app.bundleID || app.app}
                                title={`${app.app} · visible alongside for ${estimatedTime(app.seconds)}`}
                              >
                                <AppIcon app={app.app} bundleID={app.bundleID} size={14} />
                                {app.app}
                              </span>
                            ))}
                            {details.alongside.length > 3 && (
                              <span>+{details.alongside.length - 3}</span>
                            )}
                          </span>
                        </div>
                      )}
                    </button>
                  </React.Fragment>
                );
              })}
              {!state.sessions.length && <p>No sessions yet. They appear as you record.</p>}
            </section>
          )}
          {!compact && tab === "saved" && (
            <section className="page">
              <PageTitle
                title="Saved clips"
                text="Pinned captures stay protected from rolling retention."
              />
              {state.clips.map((clip) => (
                <article className="card clip" key={clip.id}>
                  <div>
                    <h3>{clip.name}</h3>
                    <p>
                      {date(clip.created).toLocaleDateString()} · {clip.frameIDs.length} captures
                    </p>
                  </div>
                  <div className="actions">
                    <button className="outline" onClick={() => history(clip.frameIDs, clip.name)}>
                      Review
                    </button>
                    <button
                      className="outline"
                      onClick={() =>
                        action(async () => {
                          if (!isNative) throw Error("Export is available in the installed app.");
                          const { save } = await import("@tauri-apps/plugin-dialog");
                          const path = await withPanelDialog(() =>
                            save({
                              defaultPath: clip.name + ".zip",
                              filters: [{ name: "Capture archive", extensions: ["zip"] }],
                            }),
                          );
                          if (path) await engine("export", { id: clip.id, path });
                        }, "Clip exported.")
                      }
                    >
                      Export ZIP
                    </button>
                    <button
                      className="quiet danger"
                      onClick={async () => {
                        if (
                          await confirmAction(
                            "Delete this saved clip? Captures still covered by your history settings remain.",
                          )
                        )
                          void action(() => engine("deleteClip", { id: clip.id }));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
              {!state.clips.length && (
                <div className="empty">
                  <h2>No saved clips yet.</h2>
                  <p>Save your last hour or choose a time range in History.</p>
                </div>
              )}
            </section>
          )}
          {!compact && tab === "activity" && (
            <section className="page">
              <div className="activity-overview">
                <div>
                  <strong>{estimatedTime(activitySummary.seconds)}</strong>
                  <span>Estimated time in focus</span>
                </div>
                <select
                  aria-label="Activity range"
                  value={activityRange}
                  onChange={(event) => setActivityRange(event.target.value)}
                >
                  <option value="all">All history</option>
                  <option value="today">Today</option>
                  <option value="week">Last 7 days</option>
                </select>
              </div>
              <div className="card activity-list">
                {activitySummary.activities.map(({ label, seconds }) => {
                  const share = (seconds / Math.max(1, activitySummary.seconds)) * 100;
                  return (
                    <div className="activity-row" key={label}>
                      <div>
                        <strong>{label}</strong>
                        <span>{estimatedTime(seconds)}</span>
                      </div>
                      <div
                        className="meter"
                        role="meter"
                        aria-label={`${label} estimated time`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={share}
                        aria-valuetext={`${estimatedTime(seconds)}, ${Math.round(share)}%`}
                      >
                        <i style={{ width: share + "%" }} />
                      </div>
                    </div>
                  );
                })}
                {!activitySummary.activities.length && (
                  <p className="muted">Time estimates appear as captures arrive.</p>
                )}
              </div>
              <p className="muted">
                Estimated from capture spacing; gaps are excluded. Alongside apps don’t add extra
                focused time.
              </p>
            </section>
          )}
          {!compact && tab === "settings" && (
            <SettingsPage
              state={state}
              busy={busy}
              apply={(value) => action(() => engine("settings", value), "Logging settings saved.")}
              action={action}
              refresh={refresh}
            />
          )}
          {!compact && tab === "sync" && (
            <SyncPage
              state={state}
              busy={busy}
              action={action}
              onSettings={() => expand("settings")}
            />
          )}
        </SlidingPanels>
      </main>
    </div>
  );
}
function sessionDay(value: number) {
  const day = date(value);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return day.toDateString() === today.toDateString()
    ? "Today"
    : day.toDateString() === yesterday.toDateString()
      ? "Yesterday"
      : day.toLocaleDateString([], { month: "short", day: "numeric", weekday: "short" });
}
function sessionTime(start: number, end: number) {
  return Math.floor(start / 60) === Math.floor(end / 60)
    ? time(start)
    : `${time(start)} – ${time(end)}`;
}
function PageTitle({ title, text }: { title: string; text: string }) {
  return (
    <div className="page-intro" aria-label={title}>
      <p>{text}</p>
    </div>
  );
}
function SettingsPage({
  state,
  busy,
  apply,
  action,
  refresh,
}: {
  state: State;
  busy: boolean;
  apply: (s: Settings) => Promise<void>;
  action: (f: () => Promise<unknown>, success?: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const windows = state.capabilities.backend.startsWith("Windows");
  const [draft, setDraft] = useState(state.settings),
    [exclusions, setExclusions] = useState(state.exclusions.join("\n")),
    [server, setServer] = useState(state.server || ""),
    [startup, setStartup] = useState(false);
  useEffect(() => {
    if (isNative)
      import("@tauri-apps/plugin-autostart")
        .then((p) => p.isEnabled())
        .then(setStartup)
        .catch(() => {});
  }, []);
  function field<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft({ ...draft, [key]: value });
  }
  const number = (key: keyof Settings, label: string, values: [number, string][]) => (
    <label className="setting-row">
      <span>{label}</span>
      <select
        aria-label={label}
        value={String(draft[key])}
        onChange={(e) => field(key, Number(e.target.value) as never)}
      >
        {values.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="page settings-page">
      <section className="settings-section">
        <h2>Capture</h2>
        {number("retentionHours", "Keep history", [
          [0, "Until I delete it"],
          [4, "4 hours"],
          [24, "24 hours"],
          [168, "7 days"],
          [720, "30 days"],
        ])}
        {number("intervalSeconds", "Capture interval", [
          [15, "15 seconds"],
          [30, "30 seconds"],
          [60, "1 minute"],
          [120, "2 minutes"],
          [300, "5 minutes"],
        ])}
        {number("storageGiB", "History storage", [
          [2, "2 GiB"],
          [5, "5 GiB"],
          [10, "10 GiB"],
          [20, "20 GiB"],
          [50, "50 GiB"],
          [100, "100 GiB"],
          [250, "250 GiB"],
        ])}
        <p className="muted">
          {draft.retentionHours === 0
            ? "Capture stops at the storage limit. Your history stays intact."
            : "Unsaved captures expire by age or when storage fills."}
        </p>
        <label className="setting-row">
          <span>Launch at login</span>
          <input
            type="checkbox"
            checked={startup}
            disabled={!isNative || state.demo}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void action(async () => {
                const plugin = await import("@tauri-apps/plugin-autostart");
                if (enabled) await plugin.enable();
                else await plugin.disable();
                const registered = await plugin.isEnabled();
                setStartup(registered);
                if (registered !== enabled)
                  throw Error(
                    "Login item could not be updated. Check Login Items in System Settings.",
                  );
              });
            }}
          />
        </label>
        <details>
          <summary>
            More capture options
            <Icon name="chevron" size={14} />
          </summary>
          <label className="setting-row">
            <span>Capture app and window changes</span>
            <input
              type="checkbox"
              checked={draft.captureChanges}
              onChange={(e) => field("captureChanges", e.target.checked)}
            />
          </label>
          {number("minimumEventInterval", "Minimum change interval", [
            [5, "5 seconds"],
            [10, "10 seconds"],
            [30, "30 seconds"],
            [60, "1 minute"],
          ])}
          <label className="setting-row">
            <span>Local text recognition (OCR)</span>
            <input
              type="checkbox"
              checked={draft.recognizeText}
              disabled={!state.capabilities.ocr}
              onChange={(e) => field("recognizeText", e.target.checked)}
            />
          </label>
          {!state.capabilities.ocr && (
            <p className="muted">
              Local OCR is not provided by this capture backend. Screenshots and available
              accessibility context are still captured.
            </p>
          )}
          {number("maximumWidth", "Screenshot size", [
            [0, "Native resolution"],
            [1920, "1920 px"],
            [2560, "2560 px"],
            [3840, "3840 px"],
          ])}
          {number("jpegQuality", "Screenshot quality", [
            [0.45, "Smaller files"],
            [0.65, "Balanced"],
            [0.85, "Higher quality"],
          ])}
          {number("savedStorageGiB", "Saved clips storage", [
            [4, "4 GiB"],
            [10, "10 GiB"],
            [20, "20 GiB"],
            [50, "50 GiB"],
            [100, "100 GiB"],
          ])}
        </details>
        <button
          className="apply-settings"
          disabled={busy || JSON.stringify(draft) === JSON.stringify(state.settings)}
          onClick={async () => {
            const shorter =
              draft.retentionHours > 0 &&
              (state.settings.retentionHours === 0 ||
                draft.retentionHours < state.settings.retentionHours);
            const smaller =
              draft.retentionHours > 0 && draft.storageGiB < state.settings.storageGiB;
            if (
              (shorter || smaller) &&
              !(await confirmAction(
                "Older unsaved captures may be permanently removed by these settings. Apply?",
              ))
            )
              return;
            void apply(draft);
          }}
        >
          Apply logging settings
        </button>
      </section>
      <section className="settings-section">
        <h2>Appearance</h2>
        <ThemePicker />
      </section>
      <section className="settings-section">
        <h2>Privacy</h2>
        <div className="setting-row">
          <span>Screen recording</span>
          <span>
            {state.capabilities.permission === "managed-by-desktop"
              ? "Available"
              : state.capabilities.permission === "granted"
                ? "Allowed"
                : state.capabilities.permission === "required"
                  ? "Required"
                  : state.capabilities.permission || "Unavailable"}
          </span>
        </div>
        <div className="setting-row">
          <span>Accessibility</span>
          <span>{state.capabilities.accessibility ? "Available" : "Not available"}</span>
        </div>
        {windows ? (
          <p className="muted">
            Windows desktop capture needs no separate permission prompt. Administrator-only and
            protected windows may provide less context.
          </p>
        ) : (
          <button
            className="outline"
            disabled={!isNative || state.demo}
            onClick={() => action(() => engine("permissions"))}
          >
            Open permission settings
          </button>
        )}
        <label>
          Never capture these apps
          <textarea
            value={exclusions}
            onChange={(e) => setExclusions(e.target.value)}
            placeholder="App bundle IDs or executable names, one per line"
          />
        </label>
        <p className="muted">
          Breadcrumb and known password managers are excluded by default. Where native filtering is
          unavailable, captures are skipped if an excluded app may be visible.
        </p>
        <button
          className="outline"
          disabled={busy}
          onClick={() =>
            action(
              () =>
                engine("exclusions", {
                  bundles: exclusions
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
              "Exclusions saved.",
            )
          }
        >
          Save exclusions
        </button>
        <details>
          <summary>
            Capture details
            <Icon name="chevron" size={14} />
          </summary>
          <div className="setting-row">
            <span>Native backend</span>
            <span>{state.capabilities.backend || "Not connected"}</span>
          </div>
          <div className="setting-row">
            <span>App exclusions</span>
            <span>{state.capabilities.exclusions || "Unknown"}</span>
          </div>
        </details>
      </section>
      <section className="settings-section">
        <h2>Account</h2>
        {state.sync?.email && <p className="account-email">{state.sync.email}</p>}
        {state.sync?.enabled ? (
          <SyncProgress sync={state.sync} />
        ) : (
          <p>Sign in to sync all your existing and future captures.</p>
        )}
        {state.sync?.error && <p role="alert">{state.sync.error}</p>}
        {Boolean(state.sync?.failed) && !state.sync?.error && (
          <p role="status">{state.sync?.failed} captures are waiting to retry.</p>
        )}
        {state.sync?.authError && <p role="alert">{state.sync.authError}</p>}
        <label>
          Portal URL
          <input
            aria-label="Portal URL"
            placeholder="https://your-breadcrumb.example"
            value={server}
            onChange={(event) => setServer(event.target.value)}
            type="url"
            disabled={Boolean(state.sync?.signingIn)}
          />
        </label>
        {state.sync?.signingIn ? (
          <div className="actions">
            <span className="muted">Approve the connection in your browser.</span>
            <button className="quiet" onClick={() => action(() => engine("cancelSignIn"))}>
              Cancel sign-in
            </button>
          </div>
        ) : (
          <div className="actions">
            <button
              disabled={busy || state.demo || !server}
              onClick={() =>
                action(async () => {
                  const result = await engine<{ url: string }>("beginSignIn", { server });
                  try {
                    const { openUrl } = await import("@tauri-apps/plugin-opener");
                    await openUrl(result.url);
                  } catch (error) {
                    await engine("cancelSignIn");
                    throw error;
                  }
                })
              }
            >
              {state.sync?.email ? "Sign in again" : "Sign in"}
              <Icon name="external" size={14} />
            </button>
            {state.connected && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  action(
                    () => engine("disconnect"),
                    "Signed out. Sync stopped; local recording continues.",
                  )
                }
              >
                Sign out
              </button>
            )}
          </div>
        )}
        <p className="muted">
          Browser approval enables automatic uploads of screenshots, text, window context, and
          accessibility trees. You can sign out to stop syncing.
        </p>
      </section>
      <section className="settings-section">
        <h2>Storage</h2>
        <div className="setting-row">
          <span>History</span>
          <span>{bytes(state.historyBytes)}</span>
        </div>
        <div className="setting-row">
          <span>Saved clips</span>
          <span>{bytes(state.savedBytes)}</span>
        </div>
        <p className="path">{state.directory}</p>
        <p className="muted">
          Captures are unencrypted local files. Account credentials are stored in a private per-user
          connection file. Capture pauses when free disk space falls below 5 GiB.
        </p>
        <button
          className="outline danger"
          disabled={busy || state.demo}
          onClick={async () => {
            if (
              await confirmAction(
                "Permanently delete the last hour locally, including saved references and queued uploads, and pause recording and sync? Already uploaded captures remain in your account.",
              )
            )
              void action(async () => {
                await engine("deleteRecent");
                await refresh();
              }, "Recent captures deleted. Recording and sync paused.");
          }}
        >
          Delete last hour & pause
        </button>
      </section>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
