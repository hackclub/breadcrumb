import { SiteHeader } from "../site-header";
import { permissionLabels, dataScopes } from "../../lib/permissions";
export const metadata = {
  title: "API & MCP · Breadcrumb",
  description: "Connect apps and agents to your Breadcrumb data with scoped permissions.",
};
export default function Docs() {
  return (
    <main className="portal">
      <SiteHeader>
        <a href="/connections">Connections</a>
        <a href="/leaderboard">Leaderboard</a>
      </SiteHeader>
      <article style={{ maxWidth: 760, margin: "48px auto", lineHeight: 1.8 }}>
        <h1>Your data, connected</h1>
        <p>
          Give an app or agent read access to your own time history. Approve its requested
          permissions in your browser, and disconnect it at any time in{" "}
          <a href="/connections">Connections</a>.
        </p>
        <h2>MCP</h2>
        <p>
          Choose a remote Streamable HTTP server in your MCP client and enter your Breadcrumb server
          URL followed by <code>/mcp</code>. The official SDK serves MCP 2026-07-28 and legacy 2025
          stateless clients. Your client discovers the authorization server and opens the approval
          screen.
        </p>
        <p>
          Tools return structured daily/hourly time, app usage, projects, or individual screenshots,
          according to the permissions you grant. Listing tools never grants new permissions.
        </p>
        <h2>OAuth</h2>
        <p>
          Use OAuth 2.1 authorization code with PKCE(S256). Discover endpoints at{" "}
          <a href="/.well-known/oauth-authorization-server/api/auth">
            authorization server metadata
          </a>
          . Use your exact server URL plus <code>/api/v1</code> as the resource for REST tokens, or{" "}
          <code>/mcp</code> for MCP tokens. Tokens for one resource cannot access the other.
        </p>
        <p>
          Clients can identify themselves using HTTPS Client ID Metadata Documents, or use dynamic
          registration at <code>/api/auth/oauth2/register</code> for compatibility. Include the
          intended resource when registering. Access tokens expire in five minutes; request{" "}
          <code>offline_access</code> if refresh access is needed. No shared account password or
          master API key is required.
        </p>
        <h2>Permissions</h2>
        <ul>
          {dataScopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code> — {permissionLabels[scope]}
            </li>
          ))}
        </ul>
        <p>
          Request <code>time:read</code> for activity, adding app and project scopes only when
          needed. Screenshots require their own permission and are never included in ordinary
          activity responses. Accessibility trees and raw screen text are not exposed.
        </p>
        <h2>REST</h2>
        <p>
          The stable API lives at <code>/api/v1</code>. Read the{" "}
          <a href="/openapi.json">OpenAPI 3.2.1 contract</a> for parameters, response schemas, and
          browser-only sharing operations. Discover the API through the{" "}
          <a href="/.well-known/api-catalog">RFC 9727 API catalog</a>.
        </p>
        <pre
          style={{ overflowX: "auto", padding: 16, background: "var(--surface)", borderRadius: 8 }}
        >
          {
            'curl "$BREADCRUMB_URL/api/v1/activity?from=2026-11-01&to=2026-11-07&timeZone=UTC" \\\n  -H "Authorization: Bearer $ACCESS_TOKEN"'
          }
        </pre>
        <p>
          Dates are inclusive. Follow <code>nextCursor</code> without changing the range or time
          zone. Activity pages contain at most 31 days; screenshot lists contain 20 captures in
          capture-ID order.
        </p>
        <h2>Errors & limits</h2>
        <p>
          Errors use RFC 9457 <code>application/problem+json</code> with a stable <code>code</code>{" "}
          and a concrete <code>resolution</code>. Authenticated access allows120 requests per
          user/client per minute, shared between REST or MCP operations. Responses advertise{" "}
          <code>RateLimit-Policy</code> and <code>RateLimit</code>; honor <code>Retry-After</code>{" "}
          on 429. Screenshot image responses are private and never cacheable.
        </p>
        <h2>Sharing & interpretation</h2>
        <p>
          Screenshot links are explicit, unlisted, expiring, and revocable. Anyone holding a link
          can see that one image until it expires or is revoked. Review the preview before sharing.
        </p>
        <p>
          The leaderboard shows observed time for public profiles by default; opt out on the{" "}
          <a href="/leaderboard">leaderboard</a> or make your profile private. Actual app usage is
          hidden unless separately enabled. Curated profile app lists do not authorize activity
          sharing.
        </p>
        <p>
          Observed time estimates sampled coverage, counts overlap once, and excludes long gaps. It
          does not establish attention, productive struggle, or project quality.
        </p>
        <h2>Versioning</h2>
        <p>
          Compatible additions stay in v1. Breaking changes use a new major URL. Before retiring a
          stable version, publish a migration guide and Deprecation/Link headers; announce a Sunset
          at least 90 days in advance.
        </p>
      </article>
    </main>
  );
}
