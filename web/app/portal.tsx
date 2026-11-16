"use client";
import { useEffect, useState } from "react";
async function request(path: string, body?: unknown, token?: string) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error(await r.text());
  return r.status === 204
    ? null
    : r.headers.get("content-type")?.includes("application/json")
      ? r.json()
      : null;
}
export default function Portal() {
  const [account, setAccount] = useState<{ email: string } | null>(null),
    [email, setEmail] = useState(""),
    [token, setToken] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [login, setLogin] = useState("");
  async function me() {
    const r = await fetch("/auth/me");
    setAccount(r.ok ? await r.json() : null);
  }
  useEffect(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get("login");
    if (value) {
      setLogin(value);
      history.replaceState(null, "", location.pathname);
    }
    void me();
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!file || !consent) throw Error("Choose a capture and confirm contribution.");
    if (file.size > 13 * 1024 * 1024) throw Error("Capture bundle exceeds 13 MiB.");
    const data = JSON.parse(await file.text());
    data.consent = true;
    const encoded = JSON.stringify(data);
    if (new Blob([encoded]).size < 4 * 1024 * 1024) {
      await request("/v1/ingest", data, token);
    } else {
      const payload = new TextEncoder().encode(JSON.stringify(data.payload));
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", payload)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      const pending = await request(
        "/v1/uploads/start",
        {
          schemaVersion: 1,
          consent: true,
          record: data.record,
          size: payload.length,
          sha256: digest,
        },
        token,
      );
      for (
        let offset = 0, index = 0;
        offset < payload.length;
        offset += pending.chunkSize, index++
      ) {
        setStatus(
          `Uploading part ${index + 1} of ${Math.ceil(payload.length / pending.chunkSize)}…`,
        );
        const r = await fetch("/v1/uploads/chunk?index=" + index, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Upload-ID": pending.uploadId,
            "Content-Type": "application/octet-stream",
          },
          body: payload.slice(offset, offset + pending.chunkSize),
        });
        if (!r.ok) throw Error(await r.text());
      }
      await request("/v1/uploads/complete", { uploadId: pending.uploadId }, token);
    }
    setConsent(false);
    setStatus("Capture contributed. Thank you.");
  }
  return (
    <main className="portal">
      <header>
        <a className="wordmark" href="/" aria-label="Breadcrumb home">
          <span className="brand-icon">◌</span> breadcrumb
        </a>
        <a href="https://github.com/hackclub/breadcrumb" target="_blank" rel="noreferrer">
          Source ↗
        </a>
      </header>
      <section className="intro">
        <div className="eyebrow">A LITTLE CONTEXT GOES A LONG WAY</div>
        <h1>
          The story between
          <br />
          your screenshots.
        </h1>
        <p>
          Keep a personal history of your desktop. Contribute selected moments to help agents
          understand what happens on screen—even when more than one thing is happening.
        </p>
        <div className="chips">
          <span>Local recording</span>
          <span>You choose what to share</span>
          <span>Agent-reviewed context</span>
        </div>
      </section>
      <div className="portal-grid">
        <section className="card">
          <div className="step">01 · YOUR ACCOUNT</div>
          <h2>{account ? "Welcome back." : "Come on in."}</h2>
          {account ? (
            <>
              <p>{account.email}</p>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const result = await request("/auth/token", {});
                    setToken(result.token);
                    setStatus("Upload token created. Copy it into the desktop app to connect.");
                  })
                }
              >
                Create upload token
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await request("/auth/logout", {});
                    setAccount(null);
                    setToken("");
                    setStatus("Signed out.");
                  })
                }
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <p>Invited contributors sign in with a one-time email link.</p>
              {login && (
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await request("/auth/verify", { token: login });
                      setLogin("");
                      await me();
                      setStatus("Signed in.");
                    })
                  }
                >
                  Finish signing in
                </button>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    await request("/auth/login", { email });
                    setStatus("If you are invited, check your inbox for a sign-in link.");
                  });
                }}
              >
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
                <button disabled={busy}>Send sign-in link</button>
              </form>
            </>
          )}
          <div className="aside-note">
            Desktop recording works offline. An account is only needed to contribute to the shared
            corpus.
          </div>
        </section>
        <section className="card">
          <div className="step">02 · CONTRIBUTE A MOMENT</div>
          <h2>Your context, with permission.</h2>
          <p>
            Review a capture bundle from Breadcrumb before uploading. Screenshots, visible text,
            window context, and accessibility trees will be stored in the corpus and reviewed
            through Vercel AI Gateway.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(upload);
            }}
          >
            <label htmlFor="token">Upload token</label>
            <input
              id="token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
            <label htmlFor="bundle">Capture bundle</label>
            <input
              id="bundle"
              type="file"
              accept=".json,application/json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                required
              />
              I reviewed this capture and agree to contribute it for AI labeling and research.
            </label>
            <button disabled={busy}>{busy ? "Working…" : "Upload selected capture"}</button>
            <button
              type="button"
              className="quiet"
              disabled={busy || !token}
              onClick={() =>
                action(async () => {
                  await request("/auth/revoke", {}, token);
                  setToken("");
                  setStatus("Token revoked.");
                })
              }
            >
              Revoke token
            </button>
          </form>
          <div className="aside-note">
            Deleting local history does not delete contributions. Contact the operator to withdraw
            them.
          </div>
        </section>
      </div>
      <p className={"notice " + (status ? "visible" : "")} role="status" aria-live="polite">
        {status || " "}
      </p>
      <footer>
        Made with Hack Club. <span>Focused work. Side quests. The whole picture.</span>
      </footer>
    </main>
  );
}
