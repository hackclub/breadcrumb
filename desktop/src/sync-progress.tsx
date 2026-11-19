import type { State } from "./types";

export function SyncProgress({ sync }: { sync: NonNullable<State["sync"]> }) {
  const total = sync.uploaded + sync.pending;
  const eta = sync.etaSeconds;
  const estimate =
    eta == null
      ? "Estimating time…"
      : eta < 60
        ? "Less than a minute left"
        : eta < 3600
          ? `About ${Math.ceil(eta / 60)} min left`
          : `About ${Math.floor(eta / 3600)}h ${Math.ceil((eta % 3600) / 60)}m left`;
  return (
    <span className="sync-progress">
      <span className="sync-caption">
        <span>
          {sync.error ? "Sync needs attention" : sync.pending ? "Syncing" : "All captures synced"}
        </span>
        <span>
          {sync.uploaded.toLocaleString()} / {total.toLocaleString()}
        </span>
      </span>
      {sync.pending > 0 && (
        <>
          <progress
            aria-label="Capture sync progress"
            value={sync.uploaded}
            max={Math.max(1, total)}
          />
          <span className="sync-eta">
            {sync.error ? "Waiting to resume" : estimate} · {sync.pending.toLocaleString()}{" "}
            remaining
          </span>
        </>
      )}
    </span>
  );
}
