import { betterAuth, type BetterAuthOptions } from "better-auth";
import { isAPIError } from "better-auth/api";
import { magicLink, jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthProvider } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createHash } from "node:crypto";
import { databasePool } from "./platform-db";
import { dataScopes } from "./permissions";
export const participantID = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
export const allowedEmail = (email: string, env: NodeJS.ProcessEnv) =>
  !env.ALLOWED_EMAILS?.trim() ||
  env.ALLOWED_EMAILS.toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes(email.toLowerCase());
export async function sendSignInEmail(
  email: string,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!allowedEmail(email, env)) return;
  if (!env.LOOPS_API_KEY || !env.LOOPS_TRANSACTIONAL_ID)
    throw Error("Email sign-in is not configured");
  const response = await fetch("https://app.loops.so/api/v1/transactional", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LOOPS_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      transactionalId: env.LOOPS_TRANSACTIONAL_ID,
      email,
      dataVariables: { loginUrl: url },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Could not send sign-in email");
}
export function authOptions(options: {
  database: BetterAuthOptions["database"];
  baseURL: string;
  secret: string;
  env?: NodeJS.ProcessEnv;
  send?: (email: string, url: string) => Promise<void>;
}) {
  const env = options.env ?? process.env,
    resource = options.baseURL.replace(/\/$/, "") + "/v1";
  return {
    appName: "Breadcrumb",
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    baseURL: options.baseURL,
    secret: options.secret,
    database: options.database,
    disabledPaths: ["/token"],
    session: { expiresIn: 7 * 86400, updateAge: 86400 },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      magicLink({
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          if (!allowedEmail(email, env)) return;
          await (options.send ?? ((email, url) => sendSignInEmail(email, url, env)))(email, url);
        },
      }),
      jwt({ disableSettingJwtHeader: true }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      oauthProvider({
        loginPage: "/",
        consentPage: "/connect",
        scopes: ["email", "offline_access", "captures:sync", ...dataScopes],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "native",
        clientRegistrationDefaultScopes: ["time:read"],
        clientRegistrationAllowedScopes: [
          "email",
          "offline_access",
          "captures:sync",
          ...dataScopes,
        ],
        resources: [
          ...["/api/v1", "/mcp"].map((path) => ({
            identifier: options.baseURL.replace(/\/$/, "") + path,
            allowedScopes: ["email", "offline_access", ...dataScopes],
            accessTokenTtl: 300,
            refreshTokenTtl: 90 * 86400,
          })),
          {
            identifier: resource,
            allowedScopes: ["email", "offline_access", "captures:sync"],
            accessTokenTtl: 300,
            refreshTokenTtl: 90 * 86400,
          },
        ],
        clientRegistrationDefaultResources: [
          resource,
          ...["/api/v1", "/mcp"].map((path) => options.baseURL.replace(/\/$/, "") + path),
        ],
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 90 * 86400,
        customAccessTokenClaims: ({ user, scopes }) =>
          scopes.includes("email")
            ? { email: user?.email, email_verified: user?.emailVerified }
            : {},
        customTokenResponseFields: ({ user, scopes }) => ({
          ...(scopes.includes("email") ? { email: user?.email } : {}),
          ...(scopes.includes("captures:sync") && user
            ? { participant: participantID(user.email) }
            : {}),
        }),
      }),
    ],
  } satisfies BetterAuthOptions;
}
export function createAuth(options: Parameters<typeof authOptions>[0]) {
  return betterAuth(authOptions(options));
}
export type BreadcrumbAuth = ReturnType<typeof createAuth>;
let instance: BreadcrumbAuth | undefined;
export function getAuth() {
  if (instance) return instance;
  const baseURL = process.env.PUBLIC_URL ?? process.env.BETTER_AUTH_URL;
  if (!baseURL || !process.env.BETTER_AUTH_SECRET || !process.env.DATABASE_URL)
    throw Error("Better Auth requires PUBLIC_URL, BETTER_AUTH_SECRET, and DATABASE_URL");
  instance = createAuth({
    baseURL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: databasePool("breadcrumb_auth"),
  });
  return instance;
}
export type Identity = { id: string; email: string };
export type AuthAccess = {
  session: (req: Request) => Promise<Identity | null>;
  upload: (req: Request) => Promise<Identity | null>;
};
export function createAuthAccess(
  auth: () => BreadcrumbAuth = getAuth,
  env: NodeJS.ProcessEnv = process.env,
): AuthAccess {
  return {
    async session(req) {
      const session = await auth().api.getSession({ headers: req.headers });
      return session?.user.emailVerified && allowedEmail(session.user.email, env)
        ? { id: participantID(session.user.email), email: session.user.email }
        : null;
    },
    async upload(req) {
      try {
        const instance = auth();
        const claims = await oauthProviderResourceClient(instance)
          .getActions()
          .verifyAccessTokenRequest(req, {
            verifyOptions: {
              audience: (instance.options.baseURL as string).replace(/\/$/, "") + "/v1",
            },
            requiredScopes: ["captures:sync"],
          });
        if (
          typeof claims.email !== "string" ||
          claims.email_verified !== true ||
          !allowedEmail(claims.email, env)
        )
          return null;
        if (typeof claims.sub !== "string" || typeof claims.client_id !== "string") return null;
        const grants = await (
          await instance.$context
        ).adapter.findMany<{ scopes: string[]; resources?: string[] }>({
          model: "oauthConsent",
          select: ["scopes", "resources"],
          where: [
            { field: "userId", value: claims.sub },
            { field: "clientId", value: claims.client_id },
          ],
        });
        const audience = (instance.options.baseURL as string).replace(/\/$/, "") + "/v1";
        if (
          !grants.some(
            (grant) =>
              grant.scopes.includes("captures:sync") &&
              (!grant.resources?.length || grant.resources.includes(audience)),
          )
        )
          return null;
        return { id: participantID(claims.email), email: claims.email };
      } catch (error) {
        if (isAPIError(error) && [401, 403].includes(error.statusCode)) return null;
        throw error;
      }
    },
  };
}
