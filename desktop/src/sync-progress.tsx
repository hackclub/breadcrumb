import type { State } from "./types";

export function SyncProgress({ sync }: { sync: NonNullable<State["sync"]> }) {
  const total = sync.uploaded + sync.pending;
  const eta = sync.etaSeconds;
  const minutes = Math.ceil((eta ?? 0) / 60);
  const estimate =
    eta == null
      ? "Estimating time…"
      : eta < 60
        ? "Less than a minute left"
        : eta < 3600
          ? `About ${Math.ceil(eta / 60)} min left`
          : `About ${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""} left`;
  return (
    <span className="sync-progress">
      <span className="sync-caption">
        <span>
          {sync.paused
            ? "Sync paused"
            : sync.error
              ? "Sync needs attention"
              : !sync.enabled
                ? "Sync stopped"
                : sync.pending
                  ? "Syncing"
                  : "All captures synced"}
        </span>
        {(sync.enabled || total > 0) && (
          <span>
            {sync.uploaded.toLocaleString()} / {total.toLocaleString()}
          </span>
        )}
      </span>
      {sync.pending > 0 && (
        <>
          <progress
            aria-label="Capture sync progress"
            value={sync.uploaded}
            max={Math.max(1, total)}
          />
          <span className="sync-eta">
            {sync.paused
              ? "Paused"
              : !sync.enabled
                ? "Uploads stopped"
                : sync.error
                  ? "Waiting to resume"
                  : estimate}{" "}
            · {sync.pending.toLocaleString()} remaining
          </span>
        </>
      )}
    </span>
  );
}
