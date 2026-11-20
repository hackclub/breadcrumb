import type { Metadata } from "next";
import { SiteHeader } from "../site-header";
import { serverSignedIn } from "../server-session";
import { Connections } from "./connections";
import "./style.css";

export const metadata: Metadata = {
  title: "Connections · Breadcrumb",
  robots: { index: false, follow: false },
};

export default async function ConnectionsPage() {
  const signedIn = await serverSignedIn();
  return (
    <main className="portal connections-page">
      <SiteHeader signedIn={signedIn} />
      <div className="connections-heading">
        <h1>Connections & sharing</h1>
        <p className="muted">
          Control which apps can query your data, and which screenshots you share.
        </p>
        <a href="/docs">API and MCP setup ↗</a>
      </div>
      {signedIn ? (
        <Connections />
      ) : (
        <section className="connections-panel connections-signed-out">
          <h2>Sign in to manage connections</h2>
          <p>
            See which apps and agents can read your Breadcrumb data, disconnect them, and share
            individual screenshots with expiring links.
          </p>
          <a className="button-link" href="/?next=/connections">
            Sign in
          </a>
        </section>
      )}
    </main>
  );
}
