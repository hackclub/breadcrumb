"use client";
import { useEffect, useState } from "react";
import { TimeDashboard } from "./time-dashboard";
import type { InsightDay as Day } from "../lib/insights";
import { SiteHeader } from "./site-header";
import { HomeTrail } from "./home-trail";
async function request(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(await response.text());
  return response.status === 204 ? null : response.json();
}
// Where the magic link lands: a same-site `next` path, or this page (keeps desktop params).
function returnPath() {
  const next = new URLSearchParams(location.search).get("next");
  return next && /^\/(?![/\\])/.test(next) ? next : location.pathname + location.search;
}
export default function Portal({
  signedIn = false,
  initialDesktop = "",
}: {
  /** Session verified on the server. Sign-in and sign-out reload the page, so it stays current. */
  signedIn?: boolean;
  initialDesktop?: string;
}) {
  const [timeZone, setTimeZone] = useState("UTC"),
    [email, setEmail] = useState(""),
    [desktop, setDesktop] = useState(initialDesktop),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [days, setDays] = useState<Day[] | null>(null),
    [indexing, setIndexing] = useState(false),
    [statsError, setStatsError] = useState("");
  const dashboardVisible = !desktop && signedIn;
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    const query = new URLSearchParams(location.search);
    const client = query.get("client_id");
    if (client && query.has("sig")) {
      setDesktop(client);
    }
    const error = query.get("error");
    if (error) setStatus("Sign-in did not complete. Please try again.");
  }, []);
  useEffect(() => {
    setDays(null);
    if (!signedIn) return;
    let cancelled = false;
    let loading = false;
    let polls = 0;
    let values = new Map<string, Day>();
    // A full load replaces every day. `since` (a UTC day) asks only for days after it; servers
    // without an analytics index ignore it and return everything.
    async function fetchDays(since = "") {
      const next = since ? new Map(values) : new Map<string, Day>();
      let cursor = "";
      do {
        const query = new URLSearchParams({ timeZone });
        if (cursor) query.set("cursor", cursor);
        else if (since) query.set("since", since);
        const page = await request("/v1/account/summary?" + query);
        for (const day of page.days as Day[]) next.set(day.day, day);
        cursor = page.nextCursor;
      } while (cursor && !cancelled);
      if (!cancelled) {
        values = next;
        setDays([...values.values()]);
        setStatsError("");
      }
    }
    async function load(full: boolean) {
      if (loading || cancelled) return;
      loading = true;
      try {
        // Polls refresh recent days; a periodic full load picks up late uploads to older days.
        const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
        await fetchDays(full ? "" : recent);
        if (!full) return;
        let migration = await request("/v1/account/index", {}),
          pages = 1;
        if (migration.done) return;
        if (!cancelled) setIndexing(true);
        while (!migration.done && !cancelled) {
          migration = await request("/v1/account/index", {});
          if (++pages % 5 === 0 && !cancelled) await fetchDays();
        }
        if (!cancelled) await fetchDays();
      } catch (error) {
        if (!cancelled) setStatsError(error instanceof Error ? error.message : String(error));
      } finally {
        loading = false;
        if (!cancelled) setIndexing(false);
      }
    }
    void load(true);
    const timer = setInterval(() => {
      if (!document.hidden) void load(++polls % 10 === 0);
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signedIn, timeZone]);
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
  useEffect(() => {
    if (signedIn && desktop) location.replace("/connect" + location.search);
  }, [signedIn, desktop]);
  const dashboard = (
    <section>
      <TimeDashboard days={days ?? []} loading={days === null} timeZone={timeZone} />
      <div className="dashboard-feedback">
        <p className="sync-count">
          <span>{days ? `${captures.toLocaleString()} captures` : "Loading synced captures…"}</span>
          <span>{latest ? `Last synced ${new Date(latest).toLocaleString()}` : ""}</span>
        </p>
        <p className="dashboard-message" role={statsError ? "alert" : "status"}>
          {statsError ||
            (indexing
              ? "Updating older activity… Your dashboard will fill in as it’s indexed."
              : "\u00a0")}
        </p>
      </div>
    </section>
  );
  return (
    <main className="portal">
      <SiteHeader signedIn={signedIn} />
      <div
        className={dashboardVisible ? "dashboard" : !signedIn && !desktop ? "home" : "auth-page"}
      >
        {!signedIn && !desktop && (
          <section className="home-intro">
            <h1>See where your day went.</h1>
            <p>
              Breadcrumb runs quietly on your computer, taking periodic screenshots and noting which
              app and project you’re in. It turns them into a trail of your hours, kept on your
              device until you choose to sync.
            </p>
            <HomeTrail />
            <a className="button-link" href="/download">
              Download Breadcrumb
            </a>
          </section>
        )}
        {!signedIn ? (
          <section className="sign-in">
            <h1>{desktop ? "Sign in to Breadcrumb" : "Sign in"}</h1>
            <p>
              {desktop ? "Sign in to connect an app." : "See your synced history across devices."}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  // Loaded on demand: only this form and the consent page need the auth client.
                  const { authClient } = await import("../lib/auth-client");
                  const result = await authClient.signIn.magicLink({
                    email,
                    callbackURL: returnPath(),
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
            <h1>Opening permissions…</h1>
            <p>Review the permissions before connecting this app.</p>
          </section>
        ) : (
          dashboard
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
