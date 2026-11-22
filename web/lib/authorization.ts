import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { getAuth, type BreadcrumbAuth } from "./auth";
import { APIProblem, apiJSON, problem, sameOrigin, smallJSON } from "./api-http";
export async function authorizationDetails(request: Request, auth: BreadcrumbAuth = getAuth()) {
  try {
    const context = await auth.$context;
    let query: URLSearchParams;
    if (request.method === "POST") {
      sameOrigin(request, new URL(context.baseURL).origin);
      const body = await smallJSON(request);
      if (!body || typeof body !== "object" || !("query" in body) || typeof body.query !== "string")
        throw new APIProblem(
          400,
          "invalid_request",
          "A signed authorization query is required.",
          "Start connecting again from your app.",
        );
      query = new URLSearchParams(body.query);
    } else {
      query = new URL(request.url).searchParams;
    }
    const signed = new Set(["sig", "ba_param", ...query.getAll("ba_param")]);
    const verified = new URLSearchParams([...query].filter(([key]) => signed.has(key)));
    const { secret } = context;
    if (!(await verifyOAuthQueryParams(verified.toString(), secret)))
      throw new APIProblem(
        400,
        "expired_authorization",
        "This connection request expired or was changed.",
        "Start connecting again from your app.",
      );
    let client;
    try {
      client = await auth.api.getOAuthClientPublic({
        headers: request.headers,
        query: { client_id: verified.get("client_id") ?? "" },
      });
    } catch {
      throw new APIProblem(
        401,
        "sign_in_required",
        "Sign in before connecting an app.",
        "Return to sign in, then start the connection again.",
      );
    }
    const destination = new URL(verified.get("redirect_uri")!);
    return apiJSON({
      name: client.client_name || "Application",
      destination: destination.host || destination.href,
      identityHost: verified.get("client_id")?.startsWith("https://")
        ? new URL(verified.get("client_id")!).host
        : undefined,
      scopes: (verified.get("scope") ?? "").split(" ").filter(Boolean),
    });
  } catch (error) {
    return problem(error, request);
  }
}
