import { serverURL } from "../../../../lib/data-access";
import { dataScopes } from "../../../../lib/permissions";
export function GET(request: Request) {
  const path =
    new URL(request.url).pathname.replace("/.well-known/oauth-protected-resource", "") || "/mcp";
  if (!["/mcp", "/api/v1"].includes(path))
    return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(
    {
      resource: serverURL() + path,
      authorization_servers: [serverURL() + "/api/auth"],
      scopes_supported: dataScopes,
      bearer_methods_supported: ["header"],
      resource_documentation: serverURL() + "/docs",
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } },
  );
}
