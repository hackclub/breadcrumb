"use client";
import { useEffect, useState } from "react";
import { permissionLabels } from "../../lib/permissions";
type Connection = { id: string; name: string; clientId: string; scopes: string[] };
type Capture = { id: string; date: string; hasScreenshot: boolean };
type Share = { id: string; captureId: string; expiresAt: string };
async function call(path: string, method = "GET", body?: unknown) {
  const response = await fetch("/api/v1/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      response.status === 401
        ? "Sign in to manage connections and screenshots."
        : (result.detail ?? "Could not complete this request."),
    );
  return result;
}
export function Connections() {
  const [connections, setConnections] = useState<Connection[] | null>(null),
    [captures, setCaptures] = useState<Capture[] | null>(null),
    [shares, setShares] = useState<Share[] | null>(null),
    [cursor, setCursor] = useState(""),
    [selected, setSelected] = useState<Capture | null>(null),
    [hours, setHours] = useState("24"),
    [link, setLink] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([call("connections"), call("screenshots"), call("shares")])
      .then(([grants, images, links]) => {
        if (active) {
          setConnections(grants.entries);
          setCaptures(images.entries);
          setCursor(images.nextCursor);
          setShares(links.entries);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="connections-status" role="status">
        {error}
      </p>
      <section className="connections-panel">
        <h2>Connected apps</h2>
        <p>
          Disconnecting stops API and MCP access immediately. App names are supplied by their
          developers.
        </p>
        {connections === null ? (
          failed ? (
            <p>Connected apps couldn’t be loaded.</p>
          ) : (
            <div className="skeleton connection-placeholder" />
          )
        ) : connections.length === 0 ? (
          <p>No apps connected yet.</p>
        ) : (
          connections.map((app) => (
            <article key={app.id} className="connection-row">
              <div>
                <h3>{app.name}</h3>
                <ul>
                  {app.scopes.map((scope) => (
                    <li key={scope}>{permissionLabels[scope] ?? scope}</li>
                  ))}
                </ul>
              </div>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await call("connections", "DELETE", { id: app.id });
                    setConnections(connections.filter((c) => c.id !== app.id));
                  })
                }
              >
                Disconnect
              </button>
            </article>
          ))
        )}
      </section>
      <section className="connections-panel">
        <h2>Share a screenshot</h2>
        <p>
          Preview one capture, then create a link. Anyone with that link can view that image until
          it expires or you revoke it. Window titles, text metadata, and accessibility trees are
          excluded.
        </p>
        <div className="capture-list">
          {captures === null ? (
            failed ? (
              <p>Captures couldn’t be loaded.</p>
            ) : (
              <div className="skeleton connection-placeholder" />
            )
          ) : captures.length === 0 ? (
            <p>No synced captures yet.</p>
          ) : (
            captures.map((capture) => (
              <button
                className="capture-choice"
                key={capture.id}
                aria-pressed={selected?.id === capture.id}
                disabled={!capture.hasScreenshot || busy}
                onClick={() => {
                  setSelected(capture);
                  setLink("");
                }}
              >
                {new Date(capture.date).toLocaleString()}{" "}
                <span>{capture.hasScreenshot ? "Preview →" : "No image"}</span>
              </button>
            ))
          )}
        </div>
        {cursor && (
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const page = await call("screenshots?cursor=" + encodeURIComponent(cursor));
                setCaptures([...(captures ?? []), ...page.entries]);
                setCursor(page.nextCursor);
              })
            }
          >
            More captures
          </button>
        )}
        {selected && (
          <div className="screenshot-preview">
            <img
              src={`/api/v1/screenshots/${selected.id}/image`}
              alt="Selected desktop capture. Review its contents before sharing."
            />
            <div className="share-actions">
              <label>
                Link expires after{" "}
                <select value={hours} onChange={(e) => setHours(e.target.value)}>
                  <option value="1">1 hour</option>
                  <option value="24">24 hours</option>
                  <option value="168">7 days</option>
                </select>
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const share = await call("shares", "POST", {
                      captureId: selected.id,
                      expiresInHours: Number(hours),
                    });
                    setLink(share.url);
                    setShares([{ ...share, captureId: selected.id }, ...(shares ?? [])]);
                  })
                }
              >
                Create share link
              </button>
            </div>
            {link && (
              <div className="share-result">
                <input
                  aria-label="Screenshot share link"
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="quiet"
                  onClick={() => void action(() => navigator.clipboard.writeText(link))}
                >
                  Copy link
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      <section className="connections-panel">
        <h2>Active screenshot links</h2>
        {shares === null ? (
          failed ? (
            <p>Screenshot links couldn’t be loaded.</p>
          ) : (
            <div className="skeleton connection-placeholder" />
          )
        ) : shares.length === 0 ? (
          <p>No active links.</p>
        ) : (
          shares.map((share) => (
            <div className="connection-row" key={share.id}>
              <span>Expires {new Date(share.expiresAt).toLocaleString()}</span>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await call("shares", "DELETE", { id: share.id });
                    setShares(shares.filter((item) => item.id !== share.id));
                    setLink("");
                  })
                }
              >
                Revoke link
              </button>
            </div>
          ))
        )}
      </section>
    </>
  );
}
