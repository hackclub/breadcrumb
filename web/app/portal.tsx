"use client";
import { useEffect, useState } from "react";
import { applyTheme, readTheme, themes, type Theme } from "../lib/theme";
import { authClient } from "../lib/auth-client";
import { TimeDashboard } from "./time-dashboard";
import type { InsightDay as Day } from "../lib/insights";
async function request(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(await response.text());
  return response.status === 204 ? null : response.json();
}
export default function Portal() {
  const [theme, setTheme] = useState<Theme>("dark"),
    [email, setEmail] = useState(""),
    [desktop, setDesktop] = useState(""),
    [approval, setApproval] = useState(false),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [days, setDays] = useState<Day[] | null>(null),
    [indexing, setIndexing] = useState(false),
    [statsError, setStatsError] = useState("");
  const { data: session, isPending } = authClient.useSession();
  const account = session?.user ?? null,
    ready = !isPending;
  useEffect(() => {
    setTheme(readTheme());
    const query = new URLSearchParams(location.search);
    const client = query.get("client_id");
    if (client && query.has("sig")) {
      setDesktop(client);
      setApproval(true);
    }
    const error = query.get("error");
    if (error) setStatus("Sign-in did not complete. Please try again.");
  }, []);
  useEffect(() => {
    setDays(null);
    if (!account) return;
    let cancelled = false;
    let loading = false;
    async function load() {
      if (loading || cancelled) return;
      loading = true;
      try {
        const refresh = async () => {
          let cursor = "";
          const values: Day[] = [];
          do {
            const page = await request(
              "/v1/account/summary" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            );
            values.push(...page.days);
            cursor = page.nextCursor;
          } while (cursor && !cancelled);
          if (!cancelled) {
            setDays(values);
            setStatsError("");
          }
        };
        // Show existing summaries immediately while older captures gain breakdowns.
        await refresh();
        if (!cancelled) setIndexing(true);
        let migration,
          pages = 0;
        do {
          migration = await request("/v1/account/index", {});
          if (++pages % 5 === 0 && !cancelled) await refresh();
        } while (!migration.done && !cancelled);
        if (!cancelled) await refresh();
      } catch (error) {
        if (!cancelled) setStatsError(error instanceof Error ? error.message : String(error));
      } finally {
        loading = false;
        if (!cancelled) setIndexing(false);
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [account?.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const captures = days?.reduce((sum, day) => sum + day.captures, 0) ?? 0;
  const latest = days
    ?.map((day) => day.lastSynced)
    .sort()
    .at(-1);
  async function decide(allow: boolean) {
    const result = await authClient.oauth2.consent({ accept: allow });
    if (result.error) throw Error(result.error.message ?? "Could not complete authorization");
    setApproval(false);
    setStatus(
      allow ? "Opening Breadcrumb. Sync will start in the app." : "Desktop connection declined.",
    );
    // Better Auth follows the consent redirect through its client plugin.
  }
  return (
    <main className="portal">
      <header>
        <a className="wordmark" href="/" aria-label="Breadcrumb home">
          <svg className="brand-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="6" cy="6" r="3" />
            <circle cx="17" cy="6" r="3" />
            <circle cx="6" cy="17" r="3" />
            <circle cx="18" cy="18" r="2.7" fill="#ed6268" />
          </svg>
          Breadcrumb
        </a>
        <div className="header-actions">
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => {
              const value = event.currentTarget.value as Theme;
              applyTheme(value);
              setTheme(value);
            }}
          >
            {themes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {account && (
            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const result = await authClient.signOut();
                  if (result.error) throw Error(result.error.message ?? "Could not sign out");
                  setDays(null);
                })
              }
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <div className={account && !desktop ? "dashboard" : "auth-page"}>
        {!ready ? (
          <p className="muted" role="status">
            Loading your account…
          </p>
        ) : !account ? (
          <section className="sign-in">
            <h1>Sign in to Breadcrumb</h1>
            <p>
              {desktop
                ? "Sign in to connect your desktop app."
                : "See your synced history and connect your desktop."}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const result = await authClient.signIn.magicLink({
                    email,
                    callbackURL: location.pathname + location.search,
                  });
                  if (result.error)
                    throw Error(result.error.message ?? "Could not send sign-in email");
                  setStatus(
                    "Check your inbox for a sign-in link. Access is available to invited contributors.",
                  );
                });
              }}
            >
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <button disabled={busy}>{busy ? "Sending…" : "Send sign-in link"}</button>
            </form>
          </section>
        ) : desktop ? (
          <section className="sign-in">
            <h1>Connect your desktop</h1>
            <p className="account-email">{account.email}</p>
            {approval ? (
              <>
                <p>
                  Allow Breadcrumb on this computer to sync{" "}
                  <strong>all existing and future captures</strong> to{" "}
                  <strong>{typeof location !== "undefined" ? location.host : "this server"}</strong>
                  .
                </p>
                <p>
                  Screenshots, visible text, window context, and accessibility trees will be stored
                  in your account’s corpus for AI review. You can stop syncing by signing out in the
                  desktop app.
                </p>
                <div className="approval-actions">
                  <button disabled={busy} onClick={() => action(() => decide(true))}>
                    Allow & start syncing
                  </button>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => action(() => decide(false))}
                  >
                    Cancel
                  </button>
                </div>
                <p className="small-note">
                  Only approve if you just clicked Sign in in your desktop app.
                </p>
              </>
            ) : (
              <p className="muted">
                {status ? "Start again in the desktop app if needed." : "Checking desktop request…"}
              </p>
            )}
          </section>
        ) : (
          <section>
            {days ? <TimeDashboard days={days} /> : <h1>Your synced history</h1>}
            <p className="sync-count">
              {days
                ? `${captures.toLocaleString()} captures`
                : statsError
                  ? "Synced history is unavailable."
                  : "Loading synced captures…"}
              {latest && ` · Last synced ${new Date(latest).toLocaleString()}`}
            </p>
            {statsError && <p role="alert">{statsError}</p>}
            {indexing && (
              <p className="small-note" role="status">
                Updating older activity… Your dashboard will fill in as it’s indexed.
              </p>
            )}
            {!captures && days && !indexing && (
              <div className="connect-help">
                <h2>Connect your desktop</h2>
                <p>
                  In Breadcrumb, open Settings → Account. Enter this portal’s URL and click Sign in.
                  Approve the connection in your browser to start syncing.
                </p>
              </div>
            )}
          </section>
        )}
        {status && (
          <p className="notice visible" role="status" aria-live="polite">
            {status}
          </p>
        )}
      </div>
      <footer>
        <a href="https://github.com/hackclub/breadcrumb" target="_blank" rel="noreferrer">
          Source ↗
        </a>
      </footer>
    </main>
  );
}
