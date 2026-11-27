import { AgentUsageView as SharedAgentUsageView } from "../../web/app/agent-usage-view";
import { useEffect, useState } from "react";
import { engine, isNative, portalServer } from "./bridge";
import { Icon } from "./icons";
import type { AgentStatus, AgentUsage } from "./agent-usage-types";
export function AgentUsageSettings({ server }: { server?: string }) {
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
  return (
    <section className="settings-section" aria-label="Coding agents">
      <h2>Coding agents</h2>
      <p className="muted">
        Reads token counts from local agent logs. Chats and tool content are never stored.
      </p>
      {error && <p role="alert">{error}</p>}
      {status?.providers.map((p) => (
        <label key={p.id} className="setting-row">
          <span>
            {p.name}
            <small>{p.detected ? "Detected" : "Not found"}</small>
          </span>
          <input
            type="checkbox"
            aria-label={`Track ${p.name}`}
            checked={p.enabled}
            disabled={busy}
            onChange={async (e) => {
              setBusy(true);
              setError("");
              try {
                setStatus(
                  await engine<AgentStatus>("agentUsageSettings", {
                    provider: p.id,
                    enabled: e.target.checked,
                  }),
                );
              } catch {
                setError("Could not save coding-agent settings.");
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      ))}
      {status && (
        <p className="muted">
          {scanned ? `Last scan ${new Date(status.lastScan).toLocaleString()}` : "Not yet scanned"}
          {status.pending ? ` · ${status.pending} files pending` : ""}
        </p>
      )}
      <AgentUploadSettings initialServer={server} />
    </section>
  );
}

const loadUsage = (range: number, timeZone: string) =>
  engine<AgentUsage>("agentUsage", { range, timeZone });
export function AgentUsageView() {
  return <SharedAgentUsageView loadUsage={loadUsage} />;
}

type UploadStatus = {
  enabled: boolean;
  connected: boolean;
  server: string;
  lastSynced: string;
  error: string;
  signingIn: boolean;
  authError: string;
};
const host = (server: string) => {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
};
function AgentUploadSettings({ initialServer }: { initialServer?: string }) {
  const [state, setState] = useState<UploadStatus | null>(null),
    [server, setServer] = useState(portalServer(initialServer)),
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
          if (live) setError("Could not load token usage connection.");
        });
    void load();
    // Poll quickly only while a browser sign-in is waiting for approval.
    const timer = setInterval(load, signingIn ? 3000 : 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signingIn]);
  async function configure(args: unknown) {
    setBusy(true);
    setError("");
    try {
      setState(await engine<UploadStatus>("agentUsageSync", args));
    } catch {
      setError("Could not update token usage uploads.");
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const result = await engine<{ url: string }>("beginAgentSignIn", { server });
      if (isNative) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(result.url);
      } else window.open(result.url, "_blank", "noopener");
      setState(await engine<UploadStatus>("agentUsageSync", {}));
    } catch {
      setError("Could not start token usage sign-in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.authError && <p role="alert">{state.authError}</p>}
      {state?.connected ? (
        <>
          <label className="setting-row">
            <span>
              Upload to dashboard
              <small>
                {host(state.server)} ·{" "}
                {state.lastSynced
                  ? `Last upload ${new Date(state.lastSynced).toLocaleString()}`
                  : "Not yet uploaded"}
              </small>
            </span>
            <input
              type="checkbox"
              aria-label="Upload hourly token counts"
              checked={state.enabled}
              disabled={busy}
              onChange={(e) => void configure({ enabled: e.target.checked })}
            />
          </label>
          <div className="actions">
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void configure({ disconnect: true })}
            >
              Disconnect token usage
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="setting-row">
            <span>
              Upload to dashboard
              <small>
                {signingIn
                  ? "Approve the connection in your browser."
                  : `Hourly token counts and project names, to ${host(server)}`}
              </small>
            </span>
            <button className="quiet" disabled={busy || signingIn || !server} onClick={connect}>
              {signingIn ? "Waiting…" : "Connect"}
            </button>
          </div>
          <details>
            <summary>
              Use a different server
              <Icon name="chevron" size={14} />
            </summary>
            <label className="settings-field">
              Usage server
              <input
                aria-label="Usage server"
                type="url"
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
            </label>
          </details>
        </>
      )}
    </>
  );
}
