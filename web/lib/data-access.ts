import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { OAuthConsent } from "@better-auth/oauth-provider";
import { allowedEmail, getAuth, participantID, type BreadcrumbAuth } from "./auth";
import { APIProblem } from "./api-http";
import { dataScopes, type DataScope } from "./permissions";

export type DataPrincipal = {
  owner: string;
  participant: string;
  client: string;
  scopes: string[];
};
export function serverURL(env = process.env) {
  const value = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;
  if (!value) throw Error("Public URL is not configured");
  return value.replace(/\/$/, "");
}
export function requireScopes(
  principal: DataPrincipal,
  scopes: readonly DataScope[],
  resource: string,
) {
  if (!scopes.every((scope) => principal.scopes.includes(scope)))
    throw new APIProblem(
      403,
      "insufficient_scope",
      "This connection has not been granted the required permissions.",
      "Reconnect and approve the requested permissions.",
      {
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scopes.join(" ")}", resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}"`,
      },
    );
}
export function createDataAccess(auth: () => BreadcrumbAuth = getAuth, env = process.env) {
  return async (
    request: Request,
    resource: "/api/v1" | "/mcp",
    required: readonly DataScope[] = ["time:read"],
    sessionAllowed = false,
  ): Promise<DataPrincipal> => {
    const instance = auth();
    if (sessionAllowed && !request.headers.has("authorization")) {
      const session = await instance.api.getSession({ headers: request.headers });
      if (session?.user.emailVerified && allowedEmail(session.user.email, env))
        return {
          owner: session.user.id,
          participant: participantID(session.user.email),
          client: "browser",
          scopes: [...dataScopes],
        };
    }
    let claims;
    try {
      claims = await oauthProviderResourceClient(instance)
        .getActions()
        .verifyAccessTokenRequest(request, {
          verifyOptions: { audience: serverURL(env) + resource },
        });
    } catch {
      throw new APIProblem(
        401,
        "invalid_token",
        "A valid access token is required.",
        "Connect with OAuth authorization code and PKCE.",
        {
          "WWW-Authenticate": `Bearer resource_metadata="${serverURL(env)}/.well-known/oauth-protected-resource${resource}", scope="${required.join(" ")}"`,
        },
      );
    }
    if (typeof claims.sub !== "string" || typeof claims.client_id !== "string")
      throw new APIProblem(
        401,
        "invalid_token",
        "The connection is not available.",
        "Sign in and reconnect this application.",
      );
    const context = await instance.$context;
    const user = await context.adapter.findOne<{ email: string; emailVerified: boolean }>({
      model: "user",
      where: [{ field: "id", value: claims.sub }],
    });
    if (!user?.emailVerified || !allowedEmail(user.email, env))
      throw new APIProblem(
        401,
        "invalid_token",
        "The account is not available.",
        "Sign in and reconnect this application.",
      );
    // Check live grants as well as JWT validity so disconnecting takes effect immediately.
    const grants = await context.adapter.findMany<OAuthConsent<string[]>>({
      model: "oauthConsent",
      where: [
        { field: "userId", value: claims.sub },
        { field: "clientId", value: claims.client_id },
      ],
    });
    const tokenScopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
    const scopes = tokenScopes.filter((scope) =>
      grants.some(
        (grant) =>
          grant.scopes.includes(scope) &&
          (!grant.resources?.length || grant.resources.includes(serverURL(env) + resource)),
      ),
    );
    if (!grants.length)
      throw new APIProblem(
        401,
        "revoked_connection",
        "This connection has been disconnected.",
        "Authorize the application again.",
      );
    const principal = {
      owner: claims.sub,
      participant: participantID(user.email),
      client: claims.client_id,
      scopes,
    };
    requireScopes(principal, required, serverURL(env) + resource);
    return principal;
  };
}
export const dataAccess = createDataAccess();
