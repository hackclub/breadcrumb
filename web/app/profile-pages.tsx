"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Profile, PublicProfile as ProfileView } from "../lib/profiles";
import { appSeed, type AppEntry } from "../lib/apps";
import { AppIcon } from "./app-icon";
import { SiteHeader } from "./site-header";

class ProfileError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ProfileError(
      value.error || "Could not load this profile. Please try again.",
      response.status,
    );
  return value;
}
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="portal">
      <SiteHeader>
        <a className="profile-nav" href="/">
          Dashboard
        </a>
      </SiteHeader>
      {children}
      <footer>
        <a href="https://github.com/hackclub/breadcrumb" target="_blank" rel="noreferrer">
          Source ↗
        </a>
      </footer>
    </main>
  );
}
const empty = {
  username: "",
  displayName: "",
  bio: "",
  visibility: "public" as "public" | "private",
  shareApps: false,
  apps: [] as string[],
};
const valid = (username: string) => /^[a-z0-9][a-z0-9_]{2,23}$/.test(username);

export function ProfileSettings({ initialSignedIn = true }: { initialSignedIn?: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [draft, setDraft] = useState(empty),
    [catalog, setCatalog] = useState<AppEntry[]>(appSeed),
    [loading, setLoading] = useState(true),
    [unauthorized, setUnauthorized] = useState(!initialSignedIn),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [query, setQuery] = useState(""),
    [availability, setAvailability] = useState({ state: "idle", message: "" });
  useEffect(() => {
    let active = true;
    setLoading(true);
    setMessage("");
    setFailed(false);
    Promise.all([
      request("/api/profile"),
      fetch("/api/apps")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ])
      .then(([value, apps]) => {
        if (!active) return;
        if (Array.isArray(apps?.apps)) setCatalog(apps.apps);
        setProfile(value.profile);
        setDraft(value.profile ? { ...empty, ...value.profile } : empty);
        setUnauthorized(false);
      })
      .catch((error) => {
        if (!active) return;
        setUnauthorized(error instanceof ProfileError && error.status === 401);
        setMessage(error instanceof Error ? error.message : "Could not load your profile.");
        setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  useEffect(() => {
    if (loading || profile || !valid(draft.username)) {
      setAvailability({ state: "idle", message: "" });
      return;
    }
    const controller = new AbortController();
    setAvailability({ state: "checking", message: "Checking availability…" });
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/profile/availability?username=${encodeURIComponent(draft.username)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const value = await response.json();
        if (!response.ok) {
          if (!controller.signal.aborted)
            setAvailability({
              state: response.status === 400 ? "invalid" : "error",
              message:
                response.status === 400
                  ? "That username is reserved."
                  : response.status === 429
                    ? "Please wait a minute and try again."
                    : "Availability could not be checked. Try saving.",
            });
          return;
        }
        if (!controller.signal.aborted)
          setAvailability({
            state: value.available ? "available" : "taken",
            message: value.available
              ? "Available to reserve"
              : "This username is already reserved.",
          });
      } catch (error) {
        if (!controller.signal.aborted)
          setAvailability({
            state: "error",
            message:
              error instanceof Error ? error.message : "Saving will check availability again.",
          });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft.username, loading, profile]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const value = await request("/api/profile", {
        username: draft.username,
        displayName: draft.displayName,
        bio: draft.bio,
        visibility: draft.visibility,
        shareApps: draft.shareApps,
        apps: draft.apps,
      });
      setProfile(value.profile);
      setDraft({ ...empty, ...value.profile });
      setMessage(profile ? "Profile saved." : "Your username is reserved.");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save your profile.");
      if (error instanceof ProfileError && error.status === 409)
        setAvailability({ state: "taken", message: "This username is already reserved." });
    } finally {
      setBusy(false);
    }
  }
  const apps = catalog.filter((app) =>
    `${app.name} ${app.aliases.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Shell>
      <section className="profile-settings">
        <div className="profile-page-heading">
          <div>
            <h1>Your profile</h1>
            <p className="muted">A small place for your name and the tools you choose to share.</p>
          </div>
        </div>
        {unauthorized ? (
          <div className="profile-auth-card">
            <h2>Make it yours</h2>
            <p>Sign in to reserve a username and choose what appears on your profile.</p>
            <a className="profile-button" href="/">
              Sign in
            </a>
          </div>
        ) : (
          <form onSubmit={save} aria-busy={loading} className="profile-form">
            <fieldset disabled={loading || busy || (failed && !profile && !draft.username)}>
              <section className="profile-section">
                <h2>Your name</h2>
                <label htmlFor="profile-username">Username</label>
                <div className="username-field">
                  <span aria-hidden="true">@</span>
                  <input
                    id="profile-username"
                    name="username"
                    autoComplete="username"
                    spellCheck={false}
                    required
                    minLength={3}
                    maxLength={24}
                    pattern="[a-z0-9][a-z0-9_]{2,23}"
                    value={draft.username}
                    readOnly={Boolean(profile)}
                    onChange={(event) =>
                      setDraft({ ...draft, username: event.target.value.toLowerCase() })
                    }
                    aria-describedby="username-help username-status"
                    aria-invalid={
                      availability.state === "taken" ||
                      availability.state === "invalid" ||
                      undefined
                    }
                    placeholder={loading ? "Loading…" : "your_name"}
                  />
                </div>
                <p id="username-help" className="profile-help">
                  {profile
                    ? "Reserved to this account. Your username cannot be changed."
                    : "3–24 lowercase letters, numbers, or underscores, starting with a letter or number. Reservations stay with your account."}
                </p>
                <p
                  id="username-status"
                  className={`profile-availability ${availability.state}`}
                  role="status"
                >
                  {loading ? (
                    <span className="skeleton skeleton-caption" />
                  ) : profile ? (
                    <a href={`/u/${profile.username}`}>View your profile ↗</a>
                  ) : (
                    availability.message || "\u00a0"
                  )}
                </p>
                <label htmlFor="profile-name">
                  Display name <span className="muted">optional</span>
                </label>
                <input
                  id="profile-name"
                  name="displayName"
                  autoComplete="nickname"
                  maxLength={60}
                  value={draft.displayName}
                  onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                  placeholder="What should people call you?"
                />
                <label htmlFor="profile-bio">
                  A little about you <span className="muted">optional</span>
                </label>
                <textarea
                  id="profile-bio"
                  name="bio"
                  maxLength={280}
                  rows={3}
                  value={draft.bio}
                  onChange={(event) => setDraft({ ...draft, bio: event.target.value })}
                  placeholder="What are you making or exploring?"
                />
              </section>
              <section className="profile-section">
                <h2>What people can see</h2>
                <label className="profile-switch">
                  <span>
                    Public profile
                    <small>
                      Anyone can see your name and bio when this is on. Turning it off keeps your
                      username reserved.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.visibility === "public"}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        visibility: event.target.checked ? "public" : "private",
                      })
                    }
                  />
                </label>
                <label className="profile-switch">
                  <span>
                    Share my selected apps
                    <small>Only the apps you select below. No usage time or capture history.</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.shareApps}
                    onChange={(event) => setDraft({ ...draft, shareApps: event.target.checked })}
                  />
                </label>
                <p className="profile-help">
                  Screenshots, window titles, email, and raw history never appear on your public
                  profile.
                </p>
              </section>
              <section className="profile-section">
                <div className="profile-app-heading">
                  <h2>Apps you use</h2>
                  <span>{draft.apps.length} selected</span>
                </div>
                <p className="profile-help">
                  Curate your toolkit. These choices are separate from the apps in your captures.
                </p>
                <label htmlFor="profile-app-search" className="sr-only">
                  Find an app
                </label>
                <input
                  id="profile-app-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find an app…"
                  disabled={!draft.shareApps}
                />
                <div
                  className={`profile-app-options ${!draft.shareApps ? "not-shared" : ""}`}
                  aria-label="Choose apps to share"
                >
                  {loading
                    ? Array.from({ length: 8 }, (_, i) => (
                        <span className="profile-app-skeleton skeleton" key={i} />
                      ))
                    : apps.map((app) => (
                        <label key={app.id} className="profile-app-option">
                          <AppIcon apps={catalog} name={app.name} id={app.id} />
                          <span>{app.name}</span>
                          <input
                            type="checkbox"
                            checked={draft.apps.includes(app.id)}
                            disabled={
                              !draft.shareApps ||
                              (!draft.apps.includes(app.id) && draft.apps.length >= 30)
                            }
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                apps: event.target.checked
                                  ? [...draft.apps, app.id]
                                  : draft.apps.filter((id) => id !== app.id),
                              })
                            }
                          />
                        </label>
                      ))}
                  {!loading && !apps.length && <p className="profile-help">No matching apps.</p>}
                </div>
                <p className="profile-help">
                  {draft.shareApps
                    ? draft.visibility === "public"
                      ? "Selected apps will be visible on your public profile."
                      : "Private profiles hide selected apps."
                    : "App sharing is off. Your selections stay private."}
                </p>
              </section>
            </fieldset>
            <div className="profile-save-row">
              <button
                disabled={
                  loading ||
                  busy ||
                  (failed && !profile && !draft.username) ||
                  !valid(draft.username) ||
                  availability.state === "taken" ||
                  availability.state === "invalid" ||
                  availability.state === "checking"
                }
              >
                {busy ? "Saving…" : profile ? "Save profile" : "Reserve username"}
              </button>
              <span className="muted">
                {profile
                  ? "Save to apply changes."
                  : "Choose your privacy settings before reserving."}
              </span>
            </div>
            <p
              className={`profile-feedback ${failed ? "error" : ""}`}
              role={failed ? "alert" : "status"}
            >
              {message || "\u00a0"}
              {failed && !profile && !draft.username && (
                <button type="button" className="quiet" onClick={() => setRetry(retry + 1)}>
                  Try again
                </button>
              )}
            </p>
          </form>
        )}
      </section>
    </Shell>
  );
}

export function PublicProfile({ username }: { username: string }) {
  const [profile, setProfile] = useState<ProfileView | null>(null),
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    request(`/api/profiles/${encodeURIComponent(username)}`)
      .then((value) => {
        if (active) setProfile(value.profile);
      })
      .catch((error) => {
        if (active) {
          setProfile(null);
          setFailed(!(error instanceof ProfileError && error.status === 404));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [username, retry]);
  return (
    <Shell>
      <section className="public-profile-page">
        <div className="public-profile-card" aria-busy={loading}>
          {loading ? (
            <>
              <div className="profile-identity">
                <span className="skeleton profile-title-skeleton" />
                <span className="skeleton skeleton-caption" />
              </div>
              <div className="profile-biography">
                <span className="skeleton profile-bio-skeleton" />
                <span className="skeleton profile-bio-skeleton" />
              </div>
              <div className="public-apps">
                <h2>Apps</h2>
                <div className="public-app-list">
                  {Array.from({ length: 4 }, (_, i) => (
                    <span key={i} className="skeleton profile-app-skeleton" />
                  ))}
                </div>
              </div>
              <span className="sr-only" role="status">
                Loading profile…
              </span>
            </>
          ) : profile ? (
            <>
              <div className="profile-identity">
                <h1>{profile.displayName || profile.username}</h1>
                <p className="muted">@{profile.username}</p>
              </div>
              <div className="profile-biography">
                <p>{profile.bio}</p>
              </div>
              <div className="public-apps">
                <h2>Apps</h2>
                <div className="public-app-list">
                  {profile.apps?.length ? (
                    profile.apps.map((app) => (
                      <div className="public-app" key={app.id}>
                        <AppIcon apps={profile.apps!} name={app.name} id={app.id} />
                        <span>{app.name}</span>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No apps shared.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="profile-unavailable">
              <h1>{failed ? "Profile unavailable" : "Profile not found"}</h1>
              <p className="muted">
                {failed
                  ? "We couldn’t load this profile. Please try again."
                  : "This profile is private or doesn’t exist."}
              </p>
              {failed && <button onClick={() => setRetry(retry + 1)}>Try again</button>}
            </div>
          )}
        </div>
        <p className="profile-public-note">
          A personally curated profile. Capture history stays private.
        </p>
      </section>
    </Shell>
  );
}
