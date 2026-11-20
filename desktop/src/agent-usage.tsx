import { AgentUsageView as SharedAgentUsageView } from "../../web/app/agent-usage-view";
import { useEffect, useState } from "react";
import { engine, isNative } from "./bridge";
import type { AgentStatus, AgentUsage } from "./agent-usage-types";
export function AgentUsageSettings({
  server = "https://breadcrumb.hackclub.com",
}: {
  server?: string;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      engine<AgentStatus>("agentUsageSettings", {})
        .then((s) => {
          if (live) setStatus(s);
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
  return (
    <section className="settings-section">
      <h2>Coding agents</h2>
      <p>
        Optional local usage statistics. Enable each provider to read token counts and session
        metadata. Chats and tool content are discarded. Uploading requires a separate opt-in below.
      </p>
      {error && <p role="alert">{error}</p>}
      {status?.providers.map((p) => (
        <label key={p.id} className="agent-setting">
          <input
            type="checkbox"
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
          {p.name} <span className="muted">{p.detected ? "Detected" : "Not found"}</span>
        </label>
      ))}
      <p className="muted">
        Last scan:{" "}
        {status?.lastScan && !status.lastScan.startsWith("0001")
          ? new Date(status.lastScan).toLocaleString()
          : "Not yet scanned"}
        {status?.pending ? ` · ${status.pending} files pending` : ""}
      </p>
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
function AgentUploadSettings({ initialServer }: { initialServer: string }) {
  const [state, setState] = useState<UploadStatus | null>(null),
    [server, setServer] = useState(initialServer || "https://breadcrumb.hackclub.com"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () =>
      engine<UploadStatus>("agentUsageSync", {})
        .then((s) => {
          if (live) setState(s);
        })
        .catch(() => {
          if (live) setError("Could not load token usage connection.");
        });
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
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
  return (
    <div>
      <h3>Token usage uploads</h3>
      <p>
        Optional, separate from capture sync. Upload existing and future hourly token counts and
        project names to your private dashboard. Chats, tool content, session IDs and absolute paths
        are never uploaded.
      </p>
      {error && <p role="alert">{error}</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.authError && <p role="alert">{state.authError}</p>}
      {state?.connected ? (
        <>
          <label className="agent-setting">
            <input
              type="checkbox"
              checked={state.enabled}
              disabled={busy}
              onChange={(e) => void configure({ enabled: e.target.checked })}
            />
            Upload hourly token counts
          </label>
          <p className="muted">
            {state.server} · Last upload:{" "}
            {state.lastSynced ? new Date(state.lastSynced).toLocaleString() : "Not yet uploaded"}
          </p>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => void configure({ disconnect: true })}
          >
            Disconnect token usage
          </button>
        </>
      ) : (
        <>
          <label>
            Usage server{" "}
            <input
              aria-label="Usage server"
              type="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <button
            disabled={busy || state?.signingIn}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await engine<{ url: string }>("beginAgentSignIn", { server });
                if (isNative) {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl(result.url);
                } else window.open(result.url, "_blank", "noopener");
              } catch {
                setError("Could not start token usage sign-in.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {state?.signingIn
              ? "Approve token usage in your browser"
              : "Connect and upload token usage"}
          </button>
        </>
      )}
    </div>
  );
}
