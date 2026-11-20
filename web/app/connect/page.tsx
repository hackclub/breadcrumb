"use client";
import { useEffect, useState } from "react";
import { permissionLabels } from "../../lib/permissions";
import { SiteHeader } from "../site-header";
import { Consent } from "./consent";
type Details = { name: string; destination: string; identityHost?: string; scopes: string[] };
export default function Connect() {
  const [details, setDetails] = useState<Details | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/authorization" + location.search, { signal: controller.signal })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw Error(value.detail ?? "Could not verify this connection.");
        setDetails(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <main className="portal">
      <SiteHeader nav={false} />
      <section className="auth-page">
        <h1>Connect an app</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <p>Start the connection again from the app you want to authorize.</p>
            <a href="/">Back to sign in</a>
          </>
        ) : !details ? (
          <p role="status">Checking the connection request…</p>
        ) : (
          <>
            <p>
              <strong>{details.name}</strong> is requesting access to your Breadcrumb account.
            </p>
            <p className="small-note">
              App name supplied by the client. Approval returns to {details.destination}. Only
              approve connections you initiated.
            </p>
            {details.identityHost && (
              <p className="small-note">Client metadata from {details.identityHost}</p>
            )}
            <ul>
              {details.scopes.map((scope) => (
                <li key={scope}>{permissionLabels[scope] ?? scope}</li>
              ))}
            </ul>
            <p>You can disconnect it at any time in Connections.</p>
            <Consent syncing={details.scopes.includes("captures:sync")} />
          </>
        )}
      </section>
    </main>
  );
}
