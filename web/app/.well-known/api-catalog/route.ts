import { serverURL } from "../../../lib/data-access";
export function GET() {
  const root = serverURL();
  return Response.json(
    {
      linkset: [
        {
          anchor: root,
          "service-desc": [{ href: root + "/openapi.json", type: "application/json" }],
          "service-doc": [{ href: root + "/docs", type: "text/html" }],
          "service-meta": [
            { href: root + "/.well-known/oauth-protected-resource/mcp", type: "application/json" },
          ],
        },
      ],
    },
    {
      headers: {
        "Content-Type":
          'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
