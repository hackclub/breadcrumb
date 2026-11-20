import { isAPIError } from "better-auth/api";
import { getAuth, allowedEmail, participantID, type BreadcrumbAuth } from "./auth";
import { dataAccess, serverURL, type DataPrincipal } from "./data-access";
import { APIProblem, apiJSON, problem, sameOrigin, smallJSON } from "./api-http";
import { readActivity } from "./activity-api";
import { getLeaderboards, LeaderboardError } from "./leaderboards";
import { platformDB, requestQuota } from "./platform-db";
import { R2Store, type Store } from "./store";
import { Screenshots } from "./screenshots";

export async function browserOwner(request: Request, auth: BreadcrumbAuth = getAuth()) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified || !allowedEmail(session.user.email, process.env))
    throw new APIProblem(
      401,
      "sign_in_required",
      "Sign in to manage your account.",
      "Open / and sign in with your email address.",
    );
  return { owner: session.user.id, participant: participantID(session.user.email) };
}
export async function quota(principal: Pick<DataPrincipal, "owner" | "client">) {
  const limit = await requestQuota(principal.owner + ":" + principal.client);
  const headers = {
    "RateLimit-Policy": '"api";q=120;w=60',
    RateLimit: `"api";r=${limit.remaining};t=${limit.retry}`,
    "X-RateLimit-Limit": "120",
    "X-RateLimit-Remaining": String(limit.remaining),
  };
  if (!limit.allowed)
    throw new APIProblem(
      429,
      "rate_limit_exceeded",
      "Too many requests.",
      "Wait for Retry-After before retrying.",
      { ...headers, "Retry-After": String(limit.retry) },
    );
  return headers;
}
export async function integrationsAPI(request: Request, store?: Store) {
  let responseHeaders: Record<string, string> = {};
  const json = (value: unknown, headers: Record<string, string> = {}) =>
    apiJSON(value, { ...responseHeaders, ...headers });
  try {
    const url = new URL(request.url),
      path = url.pathname.replace(/^\/api\/v1\/?/, ""),
      method = request.method;
    const known = [
      "activity",
      "connections",
      "leaderboard",
      "leaderboard/preferences",
      "leaderboard/refresh",
      "screenshots",
      "shares",
    ];
    const image = /^screenshots\/([a-f0-9-]+)\/image$/.exec(path);
    if (!known.includes(path) && !image)
      throw new APIProblem(
        404,
        "api_route_not_found",
        "Unknown API route.",
        "Use /openapi.json to find supported operations.",
      );
    const allowed =
      path === "activity" || path === "leaderboard" || path === "screenshots" || image
        ? ["GET"]
        : path === "connections"
          ? ["GET", "DELETE"]
          : path === "leaderboard/preferences"
            ? ["GET", "PATCH"]
            : path === "leaderboard/refresh"
              ? ["POST"]
              : ["GET", "POST", "DELETE"];
    if (!allowed.includes(method))
      throw new APIProblem(
        405,
        "method_not_allowed",
        "This method is not supported.",
        `Use ${allowed.join(" or ")}.`,
        { Allow: allowed.join(", ") },
      );
    if (path === "leaderboard") {
      if ([...url.searchParams.keys()].some((key) => !["range", "limit", "cursor"].includes(key)))
        throw new APIProblem(
          400,
          "invalid_query",
          "Unknown leaderboard parameter.",
          "Use range, limit and cursor.",
        );
      return json(
        await getLeaderboards().leaderboard({
          range: (url.searchParams.get("range") ?? "7") as "7" | "30" | "all",
          limit: Number(url.searchParams.get("limit") ?? 20),
          cursor: url.searchParams.get("cursor") ?? "",
        }),
      );
    }
    store ??= new R2Store();
    if (path === "activity") {
      const principal = await dataAccess(request, "/api/v1");
      const headers = await quota(principal);
      return json(
        await readActivity(store, principal, Object.fromEntries(url.searchParams)),
        headers,
      );
    }
    const screenshots = new Screenshots(store, platformDB());
    if (path === "screenshots" || image) {
      const principal = await dataAccess(request, "/api/v1", ["screenshots:read"], true);
      const headers = await quota(principal);
      if (image) {
        const response = await screenshots.image(principal.participant, image[1]);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        return response;
      }
      return json(
        await screenshots.list(principal.participant, url.searchParams.get("cursor") ?? ""),
        headers,
      );
    }
    const owner = await browserOwner(request);
    responseHeaders = await quota({ ...owner, client: "browser" });
    if (method !== "GET") sameOrigin(request, serverURL());
    if (path === "connections") {
      const auth = getAuth();
      if (method === "DELETE") {
        const body = (await smallJSON(request)) as { id?: unknown };
        if (typeof body?.id !== "string" || body.id.length > 256)
          throw new APIProblem(
            400,
            "invalid_request",
            "Choose a connection.",
            "Send the id returned by GET /api/v1/connections.",
          );
        await auth.api.deleteOAuthConsent({ headers: request.headers, body: { id: body.id } });
        return json({ disconnected: true });
      }
      const consents = await auth.api.getOAuthConsents({ headers: request.headers });
      const entries = [];
      for (let offset = 0; offset < consents.length; offset += 5) {
        entries.push(
          ...(await Promise.all(
            consents.slice(offset, offset + 5).map(async (consent) => {
              let name = "Connected application";
              try {
                const client = await auth.api.getOAuthClientPublic({
                  headers: request.headers,
                  query: { client_id: consent.clientId },
                });
                name = client.client_name || name;
              } catch {}
              return {
                id: consent.id,
                name,
                clientId: consent.clientId,
                scopes: consent.scopes,
                resources: consent.resources ?? [],
                createdAt: consent.createdAt,
              };
            }),
          )),
        );
      }
      return json({ entries });
    }
    if (path === "leaderboard/preferences")
      return json(
        method === "GET"
          ? await getLeaderboards().preferences(owner.owner)
          : await getLeaderboards().savePreferences(
              owner.owner,
              owner.participant,
              await smallJSON(request),
            ),
      );
    if (path === "leaderboard/refresh") {
      const body = (await smallJSON(request)) as { cursor?: unknown };
      if (
        body?.cursor !== undefined &&
        (typeof body.cursor !== "string" || body.cursor.length > 4096)
      )
        throw new APIProblem(
          400,
          "invalid_cursor",
          "Invalid refresh cursor.",
          "Use nextCursor from the previous response.",
        );
      return json(
        await getLeaderboards().refresh(owner.participant, store, (body?.cursor as string) ?? ""),
      );
    }
    if (method === "GET") return json(await screenshots.shares(owner.owner));
    if (method === "POST") {
      const shared = await screenshots.share(
        owner.owner,
        owner.participant,
        await smallJSON(request),
      );
      return json({
        id: shared.id,
        url: serverURL() + "/s/" + shared.token,
        expiresAt: shared.expiresAt,
      });
    }
    const body = (await smallJSON(request)) as { id?: unknown };
    if (typeof body?.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id))
      throw new APIProblem(
        400,
        "invalid_request",
        "Choose a share link.",
        "Send the id returned when creating the link.",
      );
    await screenshots.revoke(owner.owner, body.id);
    return json({ revoked: true });
  } catch (caught) {
    let error = caught;
    if (isAPIError(error) && [400, 401, 403, 404].includes(error.statusCode))
      error = new APIProblem(
        error.statusCode,
        "connection_unavailable",
        "This connection is not available.",
        "Reload Connections and choose one of your own apps.",
      );
    if (error instanceof LeaderboardError)
      error = new APIProblem(
        error.status,
        "leaderboard_unavailable",
        error.message,
        "Check your profile visibility and query parameters.",
      );
    return problem(error, request);
  }
}
