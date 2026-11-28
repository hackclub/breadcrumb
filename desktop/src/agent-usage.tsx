import { useEffect, useState } from "react";
import { engine, isNative } from "./bridge";
import type { AgentStatus } from "./agent-usage-types";
import { agentIcon } from "../../web/lib/agent-icons";

/** "just now", "5 min ago", "3 h ago", then a date. */
export function ago(iso: string, now = Date.now()) {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
export function AgentUsageSettings() {
  const [status, setStatus] = useState<AgentStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      engine<AgentStatus>("agentUsageSettings", {})
        .then((s) => {
          if (!live) return;
          setStatus(s);
          setError("");
        })
        .catch(() => {
          if (live) setError("Could not load coding-agent settings.");
        });
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const scanned = status?.lastScan && !status.lastScan.startsWith("0001");
  const reading = status?.providers.filter((p) => p.enabled).map((p) => p.name) ?? [];
  async function toggle(provider: string, enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      setStatus(await engine<AgentStatus>("agentUsageSettings", { provider, enabled }));
    } catch {
      setError("Could not save coding-agent settings.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label="Coding agents">
      <h2>Coding agents</h2>
      <p className="muted">
        Reads token counts from local agent logs. Chats and tool content are never stored.
      </p>
      {error && <p role="alert">{error}</p>}
      {status && (
        <div className="agent-picker" role="group" aria-label="Agents to read">
          {status.providers.map((p) => {
            const icon = agentIcon(p.usageID ?? p.id);
            const label = `${p.name}, ${p.detected ? "detected" : "not found"}`;
            return (
              <button
                key={p.id}
                aria-label={label}
                title={label}
                aria-pressed={p.enabled}
                data-missing={p.detected ? undefined : ""}
                disabled={busy}
                onClick={() => void toggle(p.id, !p.enabled)}
              >
                {icon ? (
                  <img src={icon} alt="" width="24" height="24" />
                ) : (
                  <span aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {status && (
        <p className="muted agent-picker-note">
          {reading.length
            ? `Reading ${new Intl.ListFormat(undefined, { type: "conjunction" }).format(reading)}`
            : "Select an agent to read its token counts"}
          {scanned ? ` · scanned ${ago(status.lastScan)}` : ""}
          {status.pending ? ` · ${status.pending} files pending` : ""}
        </p>
      )}
      <AgentUploadSettings />
    </section>
  );
}

type UploadStatus = {
  enabled: boolean;
  connected: boolean;
  /** The account connection includes permission to upload token counts. */
  allowed: boolean;
  server: string;
  lastSynced: string;
  error: string;
  signingIn: boolean;
  authError: string;
};
/** Token usage uploads share the account connection; there is no separate sign-in. */
function AgentUploadSettings() {
  const [state, setState] = useState<UploadStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const signingIn = Boolean(state?.signingIn);
  useEffect(() => {
    let live = true;
    const load = () =>
      engine<UploadStatus>("agentUsageSync", {})
        .then((s) => {
          if (!live) return;
          setState(s);
          setError("");
        })
        .catch(() => {
          if (live) setError("Could not load token usage uploads.");
        });
    void load();
    // Poll quickly only while a browser sign-in is waiting for approval.
    const timer = setInterval(load, signingIn ? 3000 : 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signingIn]);
  async function run(work: () => Promise<UploadStatus>, failure: string) {
    setBusy(true);
    setError("");
    try {
      setState(await work());
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const allow = () =>
    run(async () => {
      const result = await engine<{ url: string }>("beginAgentSignIn", {});
      if (isNative) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(result.url);
      } else window.open(result.url, "_blank", "noopener");
      return engine<UploadStatus>("agentUsageSync", {});
    }, "Could not start sign-in.");
  const detail = !state?.connected
    ? "Sign in under Account first."
    : signingIn
      ? "Approve the connection in your browser."
      : !state.allowed
        ? "Sign in again to allow hourly token counts."
        : state.lastSynced
          ? `Last upload ${ago(state.lastSynced)}`
          : "Hourly token counts and project names. Chats are never uploaded.";
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {state?.connected && state.allowed && state.enabled && state.error && (
        <p role="alert">{state.error}</p>
      )}
      <div className="setting-row">
        <span>
          Upload to dashboard
          <small>{detail}</small>
        </span>
        {state?.connected && !state.allowed ? (
          <button className="quiet" disabled={busy || signingIn} onClick={() => void allow()}>
            {signingIn ? "Waiting…" : "Allow"}
          </button>
        ) : (
          <input
            type="checkbox"
            aria-label="Upload hourly token counts"
            checked={Boolean(state?.connected && state.enabled)}
            disabled={busy || !state?.connected}
            onChange={(e) =>
              void run(
                () => engine<UploadStatus>("agentUsageSync", { enabled: e.target.checked }),
                "Could not update token usage uploads.",
              )
            }
          />
        )}
      </div>
    </>
  );
}
