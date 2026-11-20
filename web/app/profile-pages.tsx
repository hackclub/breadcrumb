"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
function Shell({ children, signedIn }: { children: ReactNode; signedIn: boolean }) {
  return (
    <main className="portal">
      <SiteHeader signedIn={signedIn} />
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
  avatarMode: "none" as "none" | "gravatar" | "upload",
  githubUrl: "",
  websiteUrl: "",
};
const valid = (username: string) => /^[a-z0-9][a-z0-9_]{2,23}$/.test(username);

function Avatar({ name, source }: { name: string; source?: string | null }) {
  const [failed, setFailed] = useState("");
  const safe =
    source &&
    (source.startsWith("blob:") ||
      /^\/api\/profiles?(?:\/[a-z0-9_]+)?\/avatar(?:\?|$)/.test(source));
  return (
    <span className="profile-avatar">
      <svg
        className="profile-avatar-fallback"
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M4 22v-2a8 8 0 0 1 16 0v2" />
      </svg>
      {safe && source !== failed && (
        <img
          src={source!}
          width="72"
          height="72"
          alt={`${name || "Your"} profile picture`}
          onError={() => setFailed(source!)}
        />
      )}
    </span>
  );
}
function ProfileLink({ url, kind }: { url?: string; kind: "github" | "website" }) {
  let href: URL;
  try {
    href = new URL(url || "");
  } catch {
    return null;
  }
  if (
    href.protocol !== "https:" ||
    href.username ||
    href.password ||
    (kind === "github" && href.hostname !== "github.com")
  )
    return null;
  return (
    <a
      href={href.href}
      target="_blank"
      rel="noopener noreferrer"
      className="profile-external-link"
      aria-label={`${kind === "github" ? "GitHub profile" : "Personal website"} (opens in a new tab)`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {kind === "github" ? (
          <>
            <path d="M9 19c-5 1-5-3-7-3m14 6v-4a3.5 3.5 0 0 0-1-2.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 20.3 5c.2-.9.1-1.9-.3-2.8 0 0-1.2-.4-4 1.5a13.6 13.6 0 0 0-7 0C6.2 1.8 5 2.2 5 2.2A6.8 6.8 0 0 0 4.7 5 5.4 5.4 0 0 0 3.2 8.5c0 5.4 3.5 6.6 6.8 7A3.5 3.5 0 0 0 9 18v4" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="4" ry="9" />
            <path d="M3 12h18" />
          </>
        )}
      </svg>
      <span>{kind === "github" ? "GitHub" : href.hostname}</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export function ProfileSettings({
  initialSignedIn = true,
  initialProfile,
  initialCatalog = appSeed,
}: {
  initialSignedIn?: boolean;
  initialProfile?: Profile | null;
  initialCatalog?: AppEntry[];
}) {
  const [profile, setProfile] = useState<Profile | null>(initialProfile ?? null),
    [draft, setDraft] = useState(initialProfile ? { ...empty, ...initialProfile } : empty),
    [catalog, setCatalog] = useState<AppEntry[]>(initialCatalog),
    [loading, setLoading] = useState(initialProfile === undefined),
    [editing, setEditing] = useState(false),
    [unauthorized, setUnauthorized] = useState(!initialSignedIn),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [query, setQuery] = useState(""),
    [availability, setAvailability] = useState({ state: "idle", message: "" }),
    [uploading, setUploading] = useState(false),
    [progress, setProgress] = useState(0),
    [avatarMessage, setAvatarMessage] = useState(""),
    [avatarFailed, setAvatarFailed] = useState(false),
    [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    transfer = useRef<XMLHttpRequest | null>(null);
  useEffect(
    () => () => {
      transfer.current?.abort();
    },
    [],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    if (!initialSignedIn) {
      setLoading(false);
      return;
    }
    if (initialProfile !== undefined && retry === 0) return;
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
        if (value.profile)
          window.history.replaceState(window.history.state, "", `/@${value.profile.username}`);
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
  }, [retry, initialProfile, initialSignedIn]);
  useEffect(() => {
    if (editing) document.getElementById("profile-name")?.focus({ preventScroll: true });
  }, [editing]);
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
        githubUrl: draft.githubUrl,
        websiteUrl: draft.websiteUrl,
        ...(draft.avatarMode !== "upload" ? { avatarMode: draft.avatarMode } : {}),
      });
      setProfile(value.profile);
      setDraft({ ...empty, ...value.profile });
      setMessage(profile ? "Profile saved." : "Your username is reserved.");
      setEditing(false);
      setPreview(null);
      window.history.replaceState(window.history.state, "", `/@${value.profile.username}`);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save your profile.");
      if (error instanceof ProfileError && error.status === 409)
        setAvailability({ state: "taken", message: "This username is already reserved." });
    } finally {
      setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    setAvatarMessage("");
    setAvatarFailed(false);
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024 ||
      !file.size
    ) {
      setAvatarFailed(true);
      setAvatarMessage("Choose a JPG, PNG, or WebP image up to 2 MiB.");
      return;
    }
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    setProgress(0);
    try {
      const value = await new Promise<{ profile: Profile }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        transfer.current = xhr;
        xhr.open("POST", "/api/profile/avatar");
        xhr.responseType = "json";
        xhr.timeout = 60000;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.upload.onload = () => setProgress(100);
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve(xhr.response)
            : reject(
                new Error(
                  xhr.response?.error || "Could not upload this picture. Please try again.",
                ),
              );
        xhr.onerror = () => reject(new Error("Upload interrupted. Please try again."));
        xhr.ontimeout = () => reject(new Error("Upload took too long. Please try again."));
        xhr.onabort = () => reject(new Error("Upload cancelled."));
        const body = new FormData();
        body.append("avatar", file);
        xhr.send(body);
      });
      setProfile(value.profile);
      setDraft((current) => ({ ...current, avatarMode: value.profile.avatarMode }));
      setAvatarMessage("Picture uploaded. Other profile edits are saved separately.");
    } catch (error) {
      setPreview(null);
      setAvatarFailed(true);
      setAvatarMessage(error instanceof Error ? error.message : "Could not upload your picture.");
    } finally {
      transfer.current = null;
      setUploading(false);
    }
  }
  async function removeAvatar() {
    setUploading(true);
    setAvatarMessage("Removing picture…");
    setProgress(0);
    setAvatarFailed(false);
    try {
      const response = await fetch("/api/profile/avatar", {
        method: "DELETE",
        credentials: "same-origin",
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Could not remove your picture.");
      setProfile(value.profile);
      setDraft((current) => ({ ...current, avatarMode: "none" }));
      setPreview(null);
      setAvatarMessage("Profile picture removed.");
    } catch (error) {
      setAvatarFailed(true);
      setAvatarMessage(error instanceof Error ? error.message : "Could not remove your picture.");
    } finally {
      setUploading(false);
    }
  }
  const apps = catalog.filter((app) =>
    `${app.name} ${app.aliases.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  const editor = (
    <form onSubmit={save} aria-busy={loading} className="profile-form">
      <fieldset disabled={loading || busy || uploading || (failed && !profile && !draft.username)}>
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
                availability.state === "taken" || availability.state === "invalid" || undefined
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
              <a href={`/@${profile.username}`}>View your profile ↗</a>
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
          <h2>Profile picture</h2>
          <div className="profile-avatar-editor">
            <Avatar
              name={draft.displayName || draft.username}
              source={
                draft.avatarMode === "upload" && preview
                  ? preview
                  : draft.avatarMode === profile?.avatarMode
                    ? profile?.avatarURL
                    : null
              }
            />
            <div className="profile-avatar-controls">
              <label htmlFor="profile-avatar-mode" className="sr-only">
                Profile picture source
              </label>
              <select
                id="profile-avatar-mode"
                value={draft.avatarMode}
                disabled={!profile}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    avatarMode: event.target.value as typeof draft.avatarMode,
                  });
                  setPreview(null);
                  setAvatarMessage("");
                  setAvatarFailed(false);
                }}
              >
                <option value="none">Default icon</option>
                <option value="gravatar">Gravatar (opt in)</option>
                <option value="upload">Upload an image</option>
              </select>
              <div className="profile-avatar-actions">
                <button
                  type="button"
                  className="quiet"
                  disabled={!profile || draft.avatarMode !== "upload"}
                  onClick={() => fileInput.current?.click()}
                >
                  Choose image
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={!profile || profile.avatarMode === "none"}
                  onClick={() => void removeAvatar()}
                >
                  Remove picture
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                accept="image/jpeg,image/png,image/webp"
                aria-label="Upload profile picture"
                disabled={!profile || draft.avatarMode !== "upload"}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void upload(file);
                }}
              />
            </div>
          </div>
          <p className="profile-help">
            Gravatar receives a hash of your account email only if you choose it and save. Visitors
            receive the picture through Breadcrumb; your email is not published.
          </p>
          <p className="profile-help">
            JPG, PNG, or WebP · up to 2 MiB. Uploading or removing a picture applies immediately.
          </p>
          <div
            className="profile-upload-track"
            role={uploading ? "progressbar" : undefined}
            aria-label="Updating profile picture"
            aria-valuemin={uploading ? 0 : undefined}
            aria-valuemax={uploading ? 100 : undefined}
            aria-valuenow={uploading ? progress : undefined}
            aria-hidden={!uploading}
            style={{ visibility: uploading ? "visible" : "hidden" }}
          >
            <span style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
          <p
            className={`profile-avatar-feedback ${avatarFailed ? "error" : ""}`}
            role={avatarFailed ? "alert" : "status"}
          >
            {uploading
              ? avatarMessage ||
                (progress === 100 ? "Processing picture…" : `Uploading… ${progress}%`)
              : avatarMessage ||
                (!profile
                  ? "Reserve a username first to choose a picture."
                  : draft.avatarMode === "upload" && profile.avatarMode !== "upload"
                    ? "Choose an image to finish selecting Upload."
                    : draft.avatarMode !== profile.avatarMode
                      ? "Save your profile to apply this picture source."
                      : "\u00a0")}
          </p>
        </section>
        <section className="profile-section">
          <h2>Links</h2>
          <p className="profile-help">Optional links appear only when your profile is public.</p>
          <label htmlFor="profile-github">GitHub</label>
          <input
            id="profile-github"
            name="githubUrl"
            type="url"
            inputMode="url"
            autoComplete="url"
            pattern="https://.*"
            maxLength={300}
            value={draft.githubUrl}
            onChange={(event) => setDraft({ ...draft, githubUrl: event.target.value })}
            placeholder="https://github.com/yourname"
          />
          <label htmlFor="profile-website">Personal website</label>
          <input
            id="profile-website"
            name="websiteUrl"
            type="url"
            inputMode="url"
            autoComplete="url"
            pattern="https://.*"
            maxLength={300}
            value={draft.websiteUrl}
            onChange={(event) => setDraft({ ...draft, websiteUrl: event.target.value })}
            placeholder="https://example.com"
          />
        </section>
        <section className="profile-section">
          <h2>What people can see</h2>
          <label className="profile-switch">
            <span>
              Public profile
              <small>
                Anyone can see your name, picture, bio, and links when this is on. Turning it off
                keeps your username reserved.
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
            Screenshots, window titles, email, and raw history never appear on your public profile.
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
            uploading ||
            (draft.avatarMode === "upload" && profile?.avatarMode !== "upload") ||
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
          {profile ? "Save to apply changes." : "Choose your privacy settings before reserving."}
        </span>
      </div>
    </form>
  );
  return (
    <Shell signedIn={!unauthorized}>
      <section className="profile-settings">
        {profile ? (
          <div className="public-profile-card">
            {editing ? (
              <>
                <div className="profile-page-heading">
                  <h1>Edit profile</h1>
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy || uploading}
                    onClick={() => {
                      setDraft({ ...empty, ...profile });
                      setPreview(null);
                      setMessage("");
                      setAvatarMessage("");
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {editor}
              </>
            ) : (
              <ProfileDetails
                profile={{
                  ...profile,
                  avatarURL: profile.avatarURL ?? undefined,
                  apps: profile.shareApps
                    ? catalog.filter((app) => profile.apps.includes(app.id))
                    : [],
                }}
                actions={
                  <button
                    type="button"
                    className="quiet profile-edit-button"
                    onClick={() => {
                      setMessage("");
                      setEditing(true);
                    }}
                  >
                    Edit profile
                  </button>
                }
              />
            )}
          </div>
        ) : (
          <>
            <div className="profile-page-heading">
              <div>
                <h1>Your profile</h1>
                <p className="muted">
                  A small place for your name and the tools you choose to share.
                </p>
              </div>
            </div>
            {unauthorized ? (
              <div className="profile-auth-card">
                <h2>Make it yours</h2>
                <p>Sign in to reserve a username and choose what appears on your profile.</p>
                <a className="profile-button" href="/?next=/profile">
                  Sign in
                </a>
              </div>
            ) : (
              editor
            )}
          </>
        )}
        {(message || !profile || editing) && (
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
        )}
        {profile && !editing && (
          <p className="profile-public-note">
            {profile.visibility === "private"
              ? "Your profile is private. Only you can see it."
              : "Capture history stays private."}{" "}
            <a href={`/@${profile.username}`}>View your profile ↗</a>
          </p>
        )}
      </section>
    </Shell>
  );
}

function ProfileDetails({ profile, actions }: { profile: ProfileView; actions?: ReactNode }) {
  return (
    <>
      <div className="profile-card-heading">
        <div className="profile-identity">
          <Avatar name={profile.displayName || profile.username} source={profile.avatarURL} />
          <div>
            <h1>{profile.displayName || profile.username}</h1>
            <p className="muted">@{profile.username}</p>
          </div>
        </div>
        {actions}
      </div>
      {profile.bio && <p className="profile-biography">{profile.bio}</p>}
      {(profile.githubUrl || profile.websiteUrl) && (
        <nav className="profile-links" aria-label="Profile links">
          <ProfileLink url={profile.githubUrl} kind="github" />
          <ProfileLink url={profile.websiteUrl} kind="website" />
        </nav>
      )}
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
  );
}

export function PublicProfile({
  profile,
  failed = false,
  signedIn = false,
}: {
  profile: ProfileView | null;
  failed?: boolean;
  signedIn?: boolean;
}) {
  return (
    <Shell signedIn={signedIn}>
      <section className="public-profile-page">
        <div className="public-profile-card">
          {profile ? (
            <>
              <ProfileDetails profile={profile} />
            </>
          ) : (
            <div className="profile-unavailable">
              <h1>{failed ? "Profile unavailable" : "Profile not found"}</h1>
              <p className="muted">
                {failed
                  ? "We couldn’t load this profile. Please try again."
                  : "This profile is private or doesn’t exist."}
              </p>
              {failed && <button onClick={() => location.reload()}>Try again</button>}
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
