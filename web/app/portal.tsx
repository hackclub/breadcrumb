"use client";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { TimeDashboard } from "./time-dashboard";
import type { InsightDay as Day } from "../lib/insights";
import { SiteHeader } from "./site-header";
async function request(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(await response.text());
  return response.status === 204 ? null : response.json();
}
export default function Portal({
  initialDashboard = false,
  initialDesktop = "",
}: {
  initialDashboard?: boolean;
  initialDesktop?: string;
}) {
  const [timeZone, setTimeZone] = useState("UTC"),
    [email, setEmail] = useState(""),
    [desktop, setDesktop] = useState(initialDesktop),
    [approval, setApproval] = useState(Boolean(initialDesktop)),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [days, setDays] = useState<Day[] | null>(null),
    [indexing, setIndexing] = useState(false),
    [statsError, setStatsError] = useState("");
  const { data: session, isPending } = authClient.useSession();
  const account = session?.user ?? null,
    ready = !isPending;
  const dashboardVisible = !desktop && (Boolean(account) || (!ready && initialDashboard));
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
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
          const values = new Map<string, Day>();
          do {
            const query = new URLSearchParams({ timeZone });
            if (cursor) query.set("cursor", cursor);
            const page = await request("/v1/account/summary?" + query);
            for (const day of page.days as Day[]) values.set(day.day, day);
            cursor = page.nextCursor;
          } while (cursor && !cancelled);
          if (!cancelled) {
            setDays([...values.values()]);
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
  }, [account?.id, timeZone]);
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
  const dashboard = (
    <section>
      <TimeDashboard days={days ?? []} loading={!ready || days === null} timeZone={timeZone} />
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
      <SiteHeader>
        {(account || (!ready && initialDashboard)) && (
          <a className="profile-nav" href="/profile">
            Profile
          </a>
        )}
        {(account || (!ready && initialDashboard)) && (
          <button
            className="quiet"
            disabled={busy || !ready}
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
      </SiteHeader>
      <div className={dashboardVisible ? "dashboard" : "auth-page"}>
        {!ready ? (
          dashboardVisible ? (
            dashboard
          ) : (
            <section
              className="sign-in auth-skeleton"
              aria-busy="true"
              aria-label="Loading sign in"
            >
              <h1>Sign in to Breadcrumb</h1>
              <p>
                <span className="skeleton skeleton-caption" />
              </p>
              <div className="skeleton skeleton-field" />
              <div className="skeleton skeleton-field" />
            </section>
          )
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
