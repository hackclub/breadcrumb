import { engine } from "./bridge";
import { bytes, date, type State } from "./types";
import { SyncProgress } from "./sync-progress";

export function SyncPage({
  state,
  busy,
  action,
  onSettings,
}: {
  state: State;
  busy: boolean;
  action: (task: () => Promise<unknown>) => Promise<void>;
  onSettings: () => void;
}) {
  const sync = state.sync;
  if (!sync)
    return (
      <section className="page settings-page">
        <p>Sign in to sync your captures.</p>
        <button onClick={onSettings}>Open account settings</button>
      </section>
    );
  const active = sync.active ?? [];
  const rate = sync.capturesPerSecond ?? 0;
  return (
    <section className="page settings-page sync-page" aria-label="Sync details">
      <section className="settings-section">
        <SyncProgress sync={sync} />
        <div className="sync-metrics">
          <div>
            <span>Upload rate</span>
            <strong>
              {sync.paused
                ? "Paused"
                : rate
                  ? `${(rate * 60).toFixed(1)} / min`
                  : sync.pending
                    ? "Measuring…"
                    : "Idle"}
            </strong>
            <small>{bytes(sync.bytesPerSecond ?? 0)}/s</small>
          </div>
          <div>
            <span>This session</span>
            <strong>{(sync.sessionUploaded ?? 0).toLocaleString()} captures</strong>
            <small>{bytes(sync.bytesSent ?? 0)} sent</small>
          </div>
        </div>
        <div className="setting-row">
          <span>Upload workers</span>
          <select
            aria-label="Upload workers"
            value={sync.parallelism ?? 4}
            disabled={busy || !state.connected}
            onChange={(event) => {
              const concurrency = Number(event.currentTarget.value);
              void action(() => engine("syncOptions", { concurrency }));
            }}
          >
            <option value={1}>1 · Gentle</option>
            <option value={2}>2 · Balanced</option>
            <option value={4}>4 · Fast</option>
          </select>
        </div>
        <p className="muted">
          Fast sends up to four captures at once. Use fewer workers to leave more bandwidth for
          other apps.
        </p>
        <div className="actions">
          <button
            disabled={busy || !sync.enabled}
            onClick={() => action(() => engine("syncOptions", { paused: !sync.paused }))}
          >
            {sync.paused ? "Resume uploads" : "Pause uploads"}
          </button>
          <button
            disabled={busy || !sync.enabled || (!sync.error && !sync.failed)}
            onClick={() => action(() => engine("syncOptions", { retry: true }))}
          >
            Retry now
          </button>
        </div>
        {sync.error && <p role="alert">{sync.error}</p>}
        {sync.failed > 0 && (
          <p className="muted">
            {sync.failed} captures waiting to retry. Completed uploads are kept.
          </p>
        )}
      </section>
      <section className="settings-section">
        <h2>Uploading now · {active.length}</h2>
        {active.length ? (
          <ul className="sync-active">
            {active.map((capture) => (
              <li key={capture.id}>
                <span>{capture.app || "Desktop capture"}</span>
                <time>
                  {date(capture.date).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {sync.paused
              ? "Uploads are paused."
              : sync.uploading
                ? "Refreshing your connection…"
                : sync.pending
                  ? "Waiting for the next upload or retry."
                  : "Everything is up to date."}
          </p>
        )}
        <div className="setting-row">
          <span>Images reused this session</span>
          <span>{(sync.imagesReused ?? 0).toLocaleString()}</span>
        </div>
        <p className="muted">
          Repeated screenshots send a small reference once the image is synced.
        </p>
      </section>
      <section className="settings-section">
        <h2>Connection</h2>
        <p className="sync-destination">{state.server}</p>
        <p className="muted">{sync.email}</p>
        <p className="muted">
          Last synced: {sync.lastSynced ? new Date(sync.lastSynced).toLocaleString() : "Not yet"}
        </p>
        <button className="quiet" onClick={onSettings}>
          Open account settings
        </button>
      </section>
    </section>
  );
}
