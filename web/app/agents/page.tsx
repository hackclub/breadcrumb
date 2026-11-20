import { SiteHeader } from "../site-header";
import { serverSignedIn } from "../server-session";
import { AgentsDashboard } from "./usage";
export const metadata = {
  title: "Coding agents · Breadcrumb",
  robots: { index: false, follow: false },
};
export default async function AgentsPage() {
  const signedIn = await serverSignedIn();
  return (
    <main className="portal">
      <SiteHeader signedIn={signedIn} />
      {signedIn ? (
        <AgentsDashboard />
      ) : (
        <section style={{ margin: "48px auto", maxWidth: 760 }}>
          <h1>Coding agents</h1>
          <p>
            Sign in to see your private token usage. Uploading is optional and never includes chats.
          </p>
          <a href="/?next=/agents">Sign in</a>
        </section>
      )}
    </main>
  );
}
