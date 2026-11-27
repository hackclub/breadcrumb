import { useEffect, useState, type ReactNode } from "react";
import { AgentUsageSettings } from "./agent-usage";
import { confirmAction, engine, isNative, portalServer } from "./bridge";
import { Icon } from "./icons";
import { SyncProgress } from "./sync-progress";
import { ThemePicker } from "./theme-picker";
import { bytes, type Settings, type State } from "./types";
import { UpdateRows, type AppUpdates } from "./updates";

type Action = (f: () => Promise<unknown>, success?: string) => Promise<void>;
const choices = {
  intervalSeconds: [
    [15, "15 seconds"],
    [30, "30 seconds"],
    [60, "1 minute"],
    [120, "2 minutes"],
    [300, "5 minutes"],
  ],
  idleMinutes: [
    [2, "2 minutes"],
    [5, "5 minutes"],
    [10, "10 minutes"],
    [15, "15 minutes"],
    [30, "30 minutes"],
  ],
  minimumEventInterval: [
    [5, "5 seconds"],
    [10, "10 seconds"],
    [30, "30 seconds"],
    [60, "1 minute"],
  ],
  maximumWidth: [
    [1280, "1280 px"],
    [1920, "1920 px"],
    [2560, "2560 px"],
    [0, "Native"],
  ],
  jpegQuality: [
    [0.45, "Smaller files"],
    [0.65, "Balanced"],
    [0.85, "Higher quality"],
  ],
  retentionHours: [
    [0, "Until I delete it"],
    [4, "4 hours"],
    [24, "24 hours"],
    [168, "7 days"],
    [720, "30 days"],
  ],
  storageGiB: [
    [2, "2 GiB"],
    [5, "5 GiB"],
    [10, "10 GiB"],
    [20, "20 GiB"],
    [50, "50 GiB"],
    [100, "100 GiB"],
    [250, "250 GiB"],
  ],
  savedStorageGiB: [
    [4, "4 GiB"],
    [10, "10 GiB"],
    [20, "20 GiB"],
    [50, "50 GiB"],
    [100, "100 GiB"],
  ],
} satisfies Partial<Record<keyof Settings, [number, string][]>>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="setting-row">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

export function SettingsPage({
  updates,
  state,
  busy,
  apply,
  action,
  refresh,
}: {
  updates: AppUpdates;
  state: State;
  busy: boolean;
  apply: (s: Settings) => Promise<void>;
  action: Action;
  refresh: () => Promise<void>;
}) {
  const saved = JSON.stringify(state.settings);
  const [draft, setDraft] = useState(state.settings);
  // Follow saved settings (after a save or an engine-side change) unless edits are pending.
  const [base, setBase] = useState(saved);
  if (base !== saved) {
    setBase(saved);
    if (JSON.stringify(draft) === base) setDraft(state.settings);
  }
  const dirty = JSON.stringify(draft) !== saved;
  const field = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft({ ...draft, [key]: value });
  const select = (key: keyof typeof choices, label: string, hint?: string) => (
    <Row label={label} hint={hint}>
      <select
        aria-label={label}
        value={String(draft[key])}
        onChange={(e) => field(key, Number(e.target.value))}
      >
        {choices[key].map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
  async function save() {
    const shorter =
      draft.retentionHours > 0 &&
      (state.settings.retentionHours === 0 || draft.retentionHours < state.settings.retentionHours);
    const smaller = draft.retentionHours > 0 && draft.storageGiB < state.settings.storageGiB;
    if (
      (shorter || smaller) &&
      !(await confirmAction(
        "Older unsaved captures may be permanently removed by these settings. Apply?",
      ))
    )
      return;
    await apply(draft);
  }
  return (
    <section className="page settings-page">
      <AccountSection state={state} busy={busy} action={action} />
      <Section title="Recording">
        {select("intervalSeconds", "Capture interval")}
        {select(
          "idleMinutes",
          "Pause when away for",
          state.capabilities.idle === false ? "Not supported by this capture backend" : undefined,
        )}
        <Row label="Capture app and window changes">
          <input
            type="checkbox"
            checked={draft.captureChanges}
            onChange={(e) => field("captureChanges", e.target.checked)}
          />
        </Row>
        {draft.captureChanges && select("minimumEventInterval", "Minimum change interval")}
        <Row
          label="Recognize text (OCR)"
          hint={state.capabilities.ocr ? "Runs on this device" : "Not supported on this device"}
        >
          <input
            type="checkbox"
            checked={draft.recognizeText && Boolean(state.capabilities.ocr)}
            disabled={!state.capabilities.ocr}
            onChange={(e) => field("recognizeText", e.target.checked)}
          />
        </Row>
        {select("maximumWidth", "Screenshot size")}
        {select("jpegQuality", "Screenshot quality")}
      </Section>
      <PrivacySection state={state} busy={busy} action={action} refresh={refresh} />
      <Section title="Storage">
        {select("retentionHours", "Keep history")}
        {select("storageGiB", "History storage", `${bytes(state.historyBytes)} used`)}
        {select("savedStorageGiB", "Saved clips storage", `${bytes(state.savedBytes)} used`)}
        <p className="muted">
          {draft.retentionHours === 0
            ? "Recording stops at the limit; history is kept."
            : "Older unsaved captures expire by age or when storage fills."}{" "}
          Files are stored unencrypted on this device. Recording pauses below 5 GiB free.
        </p>
        <p className="path">{state.directory}</p>
      </Section>
      <AgentUsageSettings />
      <Section title="App">
        <LaunchAtLogin state={state} action={action} />
        <ThemePicker />
        <UpdateRows updates={updates} />
      </Section>
      <section className="settings-section">
        <details>
          <summary>
            Diagnostics
            <Icon name="chevron" size={14} />
          </summary>
          <div className="setting-row">
            <span>Capture backend</span>
            <span>{state.capabilities.backend || "Not connected"}</span>
          </div>
          <div className="setting-row">
            <span>App exclusions</span>
            <span>{state.capabilities.exclusions || "Unknown"}</span>
          </div>
          <div className="setting-row">
            <span>Accessibility context</span>
            <span>{state.capabilities.accessibility ? "Available" : "Not available"}</span>
          </div>
        </details>
      </section>
      {dirty && (
        <div className="settings-save" role="group" aria-label="Unsaved settings">
          <span>Unsaved changes</span>
          <button className="quiet" disabled={busy} onClick={() => setDraft(state.settings)}>
            Discard
          </button>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            Save changes
          </button>
        </div>
      )}
    </section>
  );
}

function AccountSection({ state, busy, action }: { state: State; busy: boolean; action: Action }) {
  const sync = state.sync;
  const [server, setServer] = useState(portalServer(state.server));
  const stopped = state.connected && !sync?.enabled;
  const signIn = () =>
    action(async () => {
      const result = await engine<{ url: string }>("beginSignIn", { server });
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(result.url);
      } catch (error) {
        await engine("cancelSignIn");
        throw error;
      }
    });
  const portal = (
    <>
      <label className="settings-field">
        Portal URL
        <input
          aria-label="Portal URL"
          placeholder="https://breadcrumb.hackclub.com/"
          value={server}
          onChange={(event) => setServer(event.target.value)}
          type="url"
          disabled={Boolean(sync?.signingIn)}
        />
      </label>
      <div className="actions">
        <button className="primary" disabled={busy || state.demo || !server} onClick={signIn}>
          {state.connected ? "Sign in again" : "Sign in"}
          <Icon name="external" size={14} />
        </button>
      </div>
    </>
  );
  return (
    <Section title="Account">
      {state.connected && (
        <div className="setting-row">
          <span className="account-email">{sync?.email || "Signed in"}</span>
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
        </div>
      )}
      {sync?.enabled && <SyncProgress sync={sync} />}
      {sync?.error && <p role="alert">{sync.error}</p>}
      {Boolean(sync?.failed) && !sync?.error && (
        <p role="status">{sync?.failed} captures are waiting to retry.</p>
      )}
      {sync?.authError && <p role="alert">{sync.authError}</p>}
      {sync?.signingIn ? (
        <div className="actions">
          <span className="muted">Approve the connection in your browser.</span>
          <button className="quiet" onClick={() => action(() => engine("cancelSignIn"))}>
            Cancel
          </button>
        </div>
      ) : !state.connected || stopped ? (
        <>
          {!state.connected && (
            <p className="muted">Sign in to sync captures to your private dashboard.</p>
          )}
          {portal}
        </>
      ) : (
        <details>
          <summary>
            Change portal
            <Icon name="chevron" size={14} />
          </summary>
          {portal}
        </details>
      )}
    </Section>
  );
}

function PrivacySection({
  state,
  busy,
  action,
  refresh,
}: {
  state: State;
  busy: boolean;
  action: Action;
  refresh: () => Promise<void>;
}) {
  const caps = state.capabilities;
  const windows = caps.backend.startsWith("Windows");
  const wayland = caps.backend.startsWith("Wayland");
  const saved = state.exclusions.join("\n");
  const [exclusions, setExclusions] = useState(saved);
  const [base, setBase] = useState(saved);
  if (base !== saved) {
    setBase(saved);
    if (exclusions === base) setExclusions(saved);
  }
  const list = exclusions
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const exclusionsLocked = wayland && !caps.windowContext;
  const permission =
    caps.permission === "managed-by-desktop"
      ? "Available"
      : caps.permission === "granted"
        ? "Allowed"
        : ["required", "portal-required"].includes(caps.permission)
          ? "Required"
          : caps.permission || "Unavailable";
  return (
    <Section title="Privacy">
      <div className="setting-row">
        <span>Screen recording</span>
        {wayland || windows ? (
          <span>{windows ? "No prompt needed" : permission}</span>
        ) : (
          <span className="row-actions">
            {permission}
            <button
              className="quiet"
              disabled={!isNative || state.demo}
              onClick={() => action(() => engine("permissions"))}
            >
              Open settings
            </button>
          </span>
        )}
      </div>
      {wayland && (
        <>
          <p className="muted">
            {caps.windowContext
              ? "Records the displays you share. App exclusions apply."
              : "Records everything in the shared source. Install desktop integration for app exclusions."}{" "}
            Pausing closes the stream; Stop sharing forgets the grant.
          </p>
          <div className="actions">
            {caps.desktopIntegration === "GNOME" && !caps.windowContext && (
              <button
                className="outline"
                disabled={busy || !isNative}
                onClick={() =>
                  action(
                    () => engine("install-linux-integration"),
                    "GNOME integration installed. Enable Breadcrumb desktop context in Extensions; a fresh login may be required.",
                  )
                }
              >
                Install GNOME integration
              </button>
            )}
            <button
              className="outline"
              disabled={busy || !isNative || state.demo}
              onClick={async () => {
                if (
                  !(await confirmAction(
                    caps.windowContext
                      ? "Choose the displays Breadcrumb may record. Native app exclusions apply. Your desktop may remember this permission across restarts. Connected accounts sync captured screenshots."
                      : "Record all visible content in the source you choose? Without native desktop integration, app exclusions, including password managers, cannot be applied. Your desktop may remember this permission across restarts. Connected accounts sync captured screenshots.",
                  ))
                )
                  return;
                await action(() => engine("share-source"));
              }}
            >
              Share screen or window
            </button>
            {caps.screenshot && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() => action(() => engine("stop-sharing"))}
              >
                Stop sharing
              </button>
            )}
          </div>
        </>
      )}
      <label className="settings-field">
        Never capture these apps
        <textarea
          aria-label="Never capture these apps"
          value={exclusions}
          disabled={exclusionsLocked}
          onChange={(e) => setExclusions(e.target.value)}
          placeholder="App bundle IDs or executable names, one per line"
        />
      </label>
      <p className="muted">
        {exclusionsLocked
          ? "Exclusions need native desktop integration."
          : "Breadcrumb and known password managers are always excluded."}
      </p>
      <div className="actions">
        <button
          className="outline"
          disabled={busy || exclusionsLocked || exclusions === saved}
          onClick={() => action(() => engine("exclusions", { bundles: list }), "Exclusions saved.")}
        >
          Save exclusions
        </button>
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
      </div>
    </Section>
  );
}

function LaunchAtLogin({ state, action }: { state: State; action: Action }) {
  const [startup, setStartup] = useState(false),
    [pending, setPending] = useState(false);
  useEffect(() => {
    if (isNative)
      import("@tauri-apps/plugin-autostart")
        .then((p) => p.isEnabled())
        .then(setStartup)
        .catch(() => {});
  }, []);
  return (
    <Row label="Launch at login">
      <input
        type="checkbox"
        checked={startup}
        disabled={!isNative || state.demo || pending}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          setPending(true);
          void action(async () => {
            const plugin = await import("@tauri-apps/plugin-autostart");
            if (enabled) await plugin.enable();
            else await plugin.disable();
            const registered = await plugin.isEnabled();
            setStartup(registered);
            if (registered !== enabled)
              throw Error("Login item could not be updated. Check Login Items in System Settings.");
          }).finally(() => setPending(false));
        }}
      />
    </Row>
  );
}
