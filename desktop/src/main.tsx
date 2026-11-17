import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
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
import "./style.css";
const time = (v: number) => date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function App() {
  const [state, setState] = useState<State | null>(null),
    [tab, setTab] = useState("history"),
    [compact, setCompact] = useState(true),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [payload, setPayload] = useState<Payload | null>(null),
    [filter, setFilter] = useState<string[] | null>(null),
    [filterName, setFilterName] = useState(""),
    [consent, setConsent] = useState(false),
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
  if (!state)
    return (
      <main className="loading">
        <span className="logo">◌</span>
        <h1>Breadcrumb</h1>
        <p>Opening your local history…</p>
        {message && <p role="alert">{message}</p>}
      </main>
    );
  const summary = Object.entries(
    state.observations.reduce<Record<string, number>>((counts, row) => {
      const key = shortActivity(activity(row));
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  return (
    <div className={compact ? "desktop compact-panel" : "desktop"}>
      <main className="workspace">
        <header className="topbar" data-tauri-drag-region>
          <div className="app-heading" data-tauri-drag-region>
            <strong data-tauri-drag-region>
              {!compact && (
                <button className="back-button" aria-label="Back to overview" onClick={overview}>
                  ‹
                </button>
              )}
              Breadcrumb
            </strong>
            <div className="record-status">
              <i className={state.recording ? "live" : ""} />
              <span title={state.status}>
                {compact ? (state.recording ? "Recording" : "Paused") : state.status}
              </span>
              {state.demo && <b>DEMO</b>}
            </div>
          </div>
          <div className="actions">
            <button
              className="outline compact"
              disabled={busy || state.demo}
              aria-label={state.recording ? "Pause recording" : "Start recording"}
              onClick={() => action(() => engine("toggle"))}
            >
              {state.recording ? "Pause" : "Start"}
            </button>
            <button
              className={tab === "settings" ? "icon-button selected" : "icon-button"}
              aria-label="Settings"
              title="Settings"
              onClick={() => expand("settings")}
            >
              ⚙
            </button>
            <button
              className="icon-button"
              aria-label="Hide to menu bar"
              title="Hide to menu bar"
              disabled={!isNative}
              onClick={() => void hidePanel()}
            >
              ×
            </button>
          </div>
        </header>
        <nav className="panel-nav" aria-label="Main navigation">
          {[
            ["history", "History"],
            ["sessions", "Sessions"],
            ["saved", "Saved"],
            ["activity", "Activity"],
          ].map(([id, label]) => (
            <button
              key={id}
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
            <button aria-label="Dismiss message" onClick={() => setMessage("")}>
              ×
            </button>
          </div>
        )}
        {compact && (
          <section className="quick-panel" aria-label="Recording overview">
            <div className="quick-preview">
              {payload && current ? (
                <img
                  src={`data:image/jpeg;base64,${payload.jpeg}`}
                  alt={`Latest desktop capture from ${current.app}`}
                />
              ) : (
                <span>Your first capture will appear here.</span>
              )}
            </div>
            <div className="quick-caption">
              <strong>{current?.app || "No captures yet"}</strong>
              <time>{current ? time(current.date) : ""}</time>
            </div>
            <p className="quick-title">
              {current?.windowTitle || "Start recording, then return to another app."}
            </p>
            {state.capabilities.permission === "required" && (
              <button className="outline compact" onClick={() => expand("settings")}>
                Allow Screen Recording
              </button>
            )}
            <div className="quick-actions">
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
              <button className="outline" onClick={() => expand()}>
                Open history
              </button>
            </div>
            <div className="quick-footer">
              <span>{state.observations.length} captures</span>
              <span>{bytes(state.historyBytes)} · local</span>
            </div>
          </section>
        )}
        {!compact && tab === "history" && (
          <section className="page">
            <div className="page-title">
              <div>
                <h1>{filterName || "History"}</h1>
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
                    <div className="eyebrow">IN FOCUS</div>
                    <h3>{current.context?.project || current.context?.domain || current.app}</h3>
                    <p>{current.context?.document || current.windowTitle}</p>
                  </div>
                  <div className="card context">
                    <div className="eyebrow">ALONGSIDE</div>
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
                <details className="card details">
                  <summary>Contribute this capture</summary>
                  <p>
                    This shares the screenshot, screen text, and window/tree context with the corpus
                    for AI review through Vercel AI Gateway. Local recording stays on this device
                    until you explicitly upload.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    I reviewed this capture and agree to contribute it.
                  </label>
                  <button
                    disabled={busy || !consent || !state.connected || state.demo}
                    onClick={() =>
                      action(async () => {
                        await engine("upload", { id: current.id, consent: true });
                        setConsent(false);
                      }, "Capture contributed.")
                    }
                  >
                    Upload selected capture
                  </button>
                  {!state.connected && (
                    <button className="quiet" onClick={() => setTab("settings")}>
                      Connect an upload token
                    </button>
                  )}
                </details>
              </>
            ) : (
              <div className="empty">
                <div>◌</div>
                <h2>Your history starts here.</h2>
                <p>
                  Start recording, then return to another app. Your desktop will appear here as you
                  work.
                </p>
              </div>
            )}
          </section>
        )}
        {!compact && tab === "sessions" && (
          <section className="page">
            <PageTitle title="Sessions" text="Related captures, grouped by task and context." />
            {[...state.sessions].reverse().map((session) => (
              <button
                className="session card"
                key={session.id}
                onClick={() => history(session.ids, session.title)}
              >
                <div>
                  <h3>{session.title}</h3>
                  <p>
                    {time(session.start)} – {time(session.end)} · {session.ids.length} captures
                  </p>
                  <div className="tags">
                    {session.activities.map((a) => (
                      <span className="pill" key={a}>
                        {shortActivity(a)}
                      </span>
                    ))}
                  </div>
                </div>
                <span>↗</span>
              </button>
            ))}
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
            <PageTitle
              title="Activity"
              text="Capture counts describe visible context, not verified time worked."
            />
            <div className="card activity-list">
              {summary.map(([label, count]) => (
                <div className="activity-row" key={label}>
                  <div>
                    <strong>{label}</strong>
                    <span>{count} captures</span>
                  </div>
                  <div className="meter">
                    <i
                      style={{
                        width: (count / Math.max(1, state.observations.length)) * 100 + "%",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="muted">
              Focused activity is counted once per capture. Alongside windows remain attached to
              each capture and session rather than being added as extra hours.
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
      </main>
    </div>
  );
}
function PageTitle({ title, text }: { title: string; text: string }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
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
  const [draft, setDraft] = useState(state.settings),
    [exclusions, setExclusions] = useState(state.exclusions.join("\n")),
    [server, setServer] = useState(state.server || "https://breadcrumb.hackclub.dev"),
    [token, setToken] = useState(""),
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
      <PageTitle title="Settings" text="Choose what to capture and how long to keep it." />
      <div className="card">
        <h2>Logging</h2>
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
            ? "When storage fills, new captures stop. Existing history is preserved until you delete it."
            : "Older unsaved captures expire by age, or sooner if storage fills."}
        </p>
        <details>
          <summary>More capture options</summary>
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
        <label className="setting-row">
          <span>Launch at login</span>
          <input
            type="checkbox"
            checked={startup}
            disabled={!isNative || state.demo}
            onChange={(e) =>
              action(async () => {
                const plugin = await import("@tauri-apps/plugin-autostart");
                if (e.target.checked) await plugin.enable();
                else await plugin.disable();
                setStartup(await plugin.isEnabled());
              })
            }
          />
        </label>
      </div>
      <div className="card">
        <h2>Capture & privacy</h2>
        <div className="setting-row">
          <span>Native backend</span>
          <span>{state.capabilities.backend || "Not connected"}</span>
        </div>
        <div className="setting-row">
          <span>Screen recording</span>
          <span>{state.capabilities.permission || "Unavailable"}</span>
        </div>
        <div className="setting-row">
          <span>Accessibility tree</span>
          <span>{state.capabilities.accessibility ? "Available" : "Not available"}</span>
        </div>
        <div className="setting-row">
          <span>App exclusions</span>
          <span>{state.capabilities.exclusions || "Unknown"}</span>
        </div>
        <button
          className="outline"
          disabled={!isNative || state.demo}
          onClick={() => action(() => engine("permissions"))}
        >
          Open permission settings
        </button>
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
      </div>
      <div className="card">
        <h2>Shared corpus</h2>
        <p>
          Recording is local. Connect an upload token to contribute individual captures with
          explicit consent.
        </p>
        <label>
          Server URL
          <input value={server} onChange={(e) => setServer(e.target.value)} type="url" />
        </label>
        <label>
          Upload token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            placeholder={
              state.connected
                ? "Token saved · paste a replacement"
                : "Paste a token from the web portal"
            }
          />
        </label>
        <div className="actions">
          <button
            disabled={busy || !token || state.demo}
            onClick={() =>
              action(async () => {
                await engine("connect", { server, token });
                setToken("");
              }, "Upload token saved on this device.")
            }
          >
            Save connection
          </button>
          <button
            className="outline"
            onClick={() =>
              action(async () => {
                if (!isNative) throw Error("Open " + server + " in your browser.");
                const url = new URL(server);
                if (url.protocol !== "https:") throw Error("Use an HTTPS portal URL.");
                const { openUrl } = await import("@tauri-apps/plugin-opener");
                await openUrl(url.origin);
              })
            }
          >
            Open web portal ↗
          </button>
        </div>
      </div>
      <div className="card">
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
          Captures are unencrypted local files. Upload tokens are stored in a private per-user
          connection file. Capture pauses when free disk space falls below 5 GiB.
        </p>
        <button
          className="outline danger"
          disabled={busy || state.demo}
          onClick={async () => {
            if (
              await confirmAction(
                "Permanently delete the last hour of captures, including saved references, and pause recording?",
              )
            )
              void action(async () => {
                await engine("deleteRecent");
                await refresh();
              }, "Recent captures deleted. Recording paused.");
          }}
        >
          Delete last hour & pause
        </button>
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
