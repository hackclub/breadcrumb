"use client";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";
export function Consent({ syncing }: { syncing: boolean }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.oauth2.consent({ accept });
      if (result.error) throw Error(result.error.message ?? "Could not complete authorization.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not complete authorization.");
      setBusy(false);
    }
  }
  return (
    <>
      <div className="approval-actions">
        <button disabled={busy} onClick={() => void decide(true)}>
          {syncing ? "Allow & start syncing" : "Allow access"}
        </button>
        <button className="quiet" disabled={busy} onClick={() => void decide(false)}>
          Cancel
        </button>
      </div>
      <p role="alert">{error}</p>
    </>
  );
}
