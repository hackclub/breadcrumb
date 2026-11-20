"use client";
import { useEffect, useRef, useState } from "react";
import { AppIcon } from "../app-icon";
import { appSeed, type AppEntry } from "../../lib/apps";
import { duration } from "../../lib/insights";

type Entry = {
  rank: number;
  username: string;
  displayName: string;
  avatarURL?: string;
  seconds: number;
  apps?: { name: string; id?: string; seconds: number }[];
};
type Page = { entries: Entry[]; nextCursor: string; updatedAt?: string };
type Preferences = { enabled: boolean; shareApps: boolean; profileReady?: boolean };
const ranges = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "all", label: "All time" },
];
const pageSize = 10;
async function responseData(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(body.detail || body.error || "Could not load this right now. Please try again.");
  return body;
}
function Placeholder({ className = "" }: { className?: string }) {
  return <span className={`leaderboard-placeholder ${className}`} aria-hidden="true" />;
}
function Avatar({ entry }: { entry: Entry }) {
  const [failed, setFailed] = useState("");
  const source = entry.avatarURL;
  const safe = source && /^\/api\/profiles?(?:\/[a-z0-9_]+)?\/avatar(?:\?|$)/.test(source);
  return (
    <span className="leaderboard-avatar" aria-hidden="true">
      {entry.displayName?.slice(0, 1).toUpperCase() || entry.username.slice(0, 1).toUpperCase()}
      {safe && source !== failed && (
        <img src={source} alt="" width="36" height="36" onError={() => setFailed(source)} />
      )}
    </span>
  );
}

export function Leaderboard() {
  const [range, setRange] = useState("7");
  const [cursors, setCursors] = useState([""]);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<AppEntry[]>(appSeed);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [preferenceState, setPreferenceState] = useState<
    "loading" | "ready" | "signed-out" | "error"
  >("loading");
  const [saving, setSaving] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const refreshController = useRef<AbortController | null>(null);
  const refreshCursor = useRef("");
  const [notice, setNotice] = useState("");
  const previous = useRef({ range, cursor: "" });
  const cursor = cursors.at(-1) || "";

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/apps", { signal: controller.signal })
      .then(responseData)
      .then((value) => {
        if (Array.isArray(value.apps)) setCatalog(value.apps);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/leaderboard/preferences", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setPreferenceState("signed-out");
          return;
        }
        const value = await responseData(response);
        setPreferences(value);
        setPreferenceState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreferenceState("error");
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const changed = previous.current.range !== range || previous.current.cursor !== cursor;
    previous.current = { range, cursor };
    if (changed) {
      setLoading(true);
      setPage(null);
    }
    const query = new URLSearchParams({ range, limit: String(pageSize) });
    if (cursor) query.set("cursor", cursor);
    fetch(`/api/v1/leaderboard?${query}`, { cache: "no-store", signal: controller.signal })
      .then(responseData)
      .then((value: Page) => {
        if (!controller.signal.aborted) {
          setPage(value);
          setError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load the leaderboard. Please try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [range, cursor, refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setRefresh((value) => value + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => refreshController.current?.abort(), []);
  async function refreshSharedTime() {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setIndexing(true);
    setNotice("Updating your shared time…");
    try {
      for (let count = 0; count < 50; count++) {
        const value = await responseData(
          await fetch("/api/v1/leaderboard/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cursor: refreshCursor.current }),
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return;
        refreshCursor.current = value.nextCursor || "";
        if (value.done) {
          refreshCursor.current = "";
          setNotice("Your shared time is up to date.");
          setRefresh((value) => value + 1);
          return;
        }
      }
      setNotice("More activity is ready to update. Continue below.");
    } catch {
      if (!controller.signal.aborted) setNotice("Your update paused. Try updating again below.");
    } finally {
      if (refreshController.current === controller) setIndexing(false);
    }
  }
  async function save(next: Preferences) {
    if (saving) return;
    const before = preferences;
    setPreferences(next);
    setSaving(true);
    setNotice("Saving sharing preferences…");
    if (!next.enabled) {
      refreshController.current?.abort();
      setIndexing(false);
    }
    try {
      const value = await responseData(
        await fetch("/api/v1/leaderboard/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next.enabled, shareApps: next.shareApps }),
        }),
      );
      setPreferences(value);
      setNotice(
        value.enabled ? "Sharing preferences saved." : "You are hidden from the leaderboard.",
      );
      setRefresh((value) => value + 1);
      if (value.enabled && (!preferences?.enabled || (value.shareApps && !preferences?.shareApps)))
        void refreshSharedTime();
    } catch {
      setPreferences(before);
      setNotice("Could not save your sharing settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="leaderboard-content">
      <div className="leaderboard-heading">
        <span className="leaderboard-eyebrow">A little shared momentum</span>
        <h1>Keep good company.</h1>
        <p>
          See where the community spends its time, and discover the apps people use along the way.
        </p>
      </div>
      <section
        className="leaderboard-sharing"
        aria-label="Your leaderboard sharing"
        aria-busy={preferenceState === "loading" || saving}
      >
        <div>
          <h2>Your place here</h2>
          <p>
            Public profiles appear by default. Hide your time here or make your profile private. App
            usage is shared separately.
          </p>
        </div>
        <div className="leaderboard-sharing-controls">
          {preferenceState === "loading" ? (
            <div
              className="leaderboard-preference-skeleton"
              aria-label="Loading sharing preferences"
            >
              <Placeholder />
              <Placeholder />
            </div>
          ) : preferenceState === "signed-out" ? (
            <p>
              <a className="leaderboard-link" href="/">
                Sign in
              </a>{" "}
              to choose what you share.
            </p>
          ) : preferenceState === "error" ? (
            <p>
              Sharing settings are unavailable.{" "}
              <a className="leaderboard-link" href="/profile">
                Open your profile
              </a>
              .
            </p>
          ) : (
            preferences && (
              <>
                {preferences.profileReady === false && (
                  <p className="leaderboard-profile-hint">
                    <a className="leaderboard-link" href="/profile">
                      Set up a public profile
                    </a>{" "}
                    to join the leaderboard.
                  </p>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.enabled}
                    disabled={saving || preferences.profileReady === false}
                    onChange={(event) =>
                      void save({ ...preferences, enabled: event.currentTarget.checked })
                    }
                  />
                  <span>Show my observed time</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.shareApps}
                    disabled={saving || !preferences.enabled || preferences.profileReady === false}
                    onChange={(event) =>
                      void save({ ...preferences, shareApps: event.currentTarget.checked })
                    }
                  />
                  <span>Also share my most-used apps and their time</span>
                </label>
              </>
            )
          )}
          {preferences?.enabled && preferences.profileReady !== false && (
            <button
              className="quiet leaderboard-refresh"
              disabled={indexing || saving}
              onClick={() => void refreshSharedTime()}
            >
              {indexing
                ? "Updating shared time…"
                : refreshCursor.current
                  ? "Continue updating"
                  : "Update shared time"}
            </button>
          )}
          <p className="leaderboard-notice" role="status">
            {notice}
          </p>
        </div>
      </section>
      <section className="leaderboard-board" aria-label="Community leaderboard" aria-busy={loading}>
        <div className="leaderboard-toolbar">
          <h2>Time together</h2>
          <div className="leaderboard-ranges" aria-label="Leaderboard time range">
            {ranges.map((item) => (
              <button
                key={item.value}
                aria-pressed={range === item.value}
                onClick={() => {
                  if (range === item.value) return;
                  setLoading(true);
                  setPage(null);
                  setRange(item.value);
                  setCursors([""]);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <p className="leaderboard-context">
          Estimated observed time, with overlapping activity counted once. This is not a measure of
          productive work.
        </p>
        <div className="leaderboard-column-labels" aria-hidden="true">
          <span>#</span>
          <span>Person</span>
          <span>Most-used apps</span>
          <span>Observed time</span>
        </div>
        <ol
          className="leaderboard-list"
          aria-label="People ranked by shared observed time"
          aria-hidden={loading || undefined}
        >
          {Array.from({ length: pageSize }, (_, index) => {
            const entry = loading ? undefined : page?.entries[index];
            return (
              <li
                className={`leaderboard-row${!loading && !entry ? " leaderboard-row-empty" : ""}`}
                key={entry?.username || index}
                aria-hidden={!entry || undefined}
              >
                <span className="leaderboard-rank">{entry ? entry.rank : <Placeholder />}</span>
                {entry ? (
                  <a
                    className="leaderboard-person"
                    href={`/@${encodeURIComponent(entry.username)}`}
                  >
                    <Avatar entry={entry} />
                    <span>
                      <strong>{entry.displayName || entry.username}</strong>
                      <small>@{entry.username}</small>
                    </span>
                  </a>
                ) : (
                  <div className="leaderboard-person">
                    <Placeholder className="leaderboard-avatar" />
                    <span>
                      <Placeholder />
                      <Placeholder />
                    </span>
                  </div>
                )}
                <div className="leaderboard-apps">
                  {!entry ? (
                    <Placeholder />
                  ) : entry.apps === undefined ? (
                    <span className="leaderboard-private">App usage private</span>
                  ) : entry.apps.length ? (
                    entry.apps.slice(0, 3).map((app) => (
                      <span
                        className="leaderboard-app"
                        key={app.id || app.name}
                        title={`${app.name} · ${duration(app.seconds)}`}
                      >
                        <AppIcon apps={catalog} name={app.name} id={app.id} />
                        <span>{app.name}</span>
                      </span>
                    ))
                  ) : (
                    <span className="leaderboard-private">No app usage yet</span>
                  )}
                </div>
                <strong className="leaderboard-time">
                  {entry ? duration(entry.seconds) : <Placeholder />}
                </strong>
              </li>
            );
          })}
        </ol>
        <div className="leaderboard-empty" role="status">
          {!loading && !error && !page?.entries.length
            ? "A quiet start. Be the first to share a little momentum."
            : ""}
        </div>
        <div className="leaderboard-pagination">
          <span role="status">
            {error ||
              (loading
                ? "Loading shared activity…"
                : page?.updatedAt
                  ? "Updates as activity syncs"
                  : "Private profiles and hidden time are excluded")}
          </span>
          {error && (
            <button className="quiet" onClick={() => setRefresh((value) => value + 1)}>
              Try again
            </button>
          )}
          <div>
            <button
              className="quiet"
              disabled={loading || cursors.length < 2}
              onClick={() => {
                setLoading(true);
                setPage(null);
                setCursors((values) => values.slice(0, -1));
              }}
            >
              Previous
            </button>
            <button
              className="quiet"
              disabled={loading || !page?.nextCursor}
              onClick={() => {
                if (page?.nextCursor) {
                  setLoading(true);
                  setPage(null);
                  setCursors((values) => [...values, page.nextCursor]);
                }
              }}
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
