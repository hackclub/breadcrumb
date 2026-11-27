import { permissionLabels } from "./permissions";
import { serverURL } from "./data-access";
export function openAPI() {
  const base = serverURL();
  const problem = {
    description: "A recoverable error with a stable code and a resolution hint.",
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  };
  const json = (schema: unknown) => ({
    description: "Success",
    content: { "application/json": { schema } },
  });
  const object = { type: "object", additionalProperties: true };
  const param = (name: string, schema: unknown, description: string) => ({
    name,
    in: "query",
    schema,
    description,
  });
  const body = (properties: unknown, required: string[] = []) => ({
    required: true,
    content: {
      "application/json": {
        schema: { type: "object", properties, required, additionalProperties: false },
      },
    },
  });
  const responses = (schema: unknown) => ({
    "200": json(schema),
    "400": problem,
    "401": problem,
    "403": problem,
    "429": problem,
    "503": problem,
  });
  const agentRow = {
    type: "object",
    additionalProperties: false,
    required: [
      "provider",
      "model",
      "project",
      "input",
      "cacheRead",
      "cacheWrite",
      "cacheWrite1h",
      "output",
      "reasoning",
      "events",
      "sessions",
    ],
    properties: {
      provider: { type: "string", maxLength: 200 },
      model: { type: "string", maxLength: 200 },
      project: {
        type: "string",
        maxLength: 200,
        description: "Project name only, never a path or user identity.",
      },
      ...Object.fromEntries(
        [
          "input",
          "cacheRead",
          "cacheWrite",
          "cacheWrite1h",
          "output",
          "reasoning",
          "events",
          "sessions",
        ].map((k) => [k, { type: "integer", minimum: 0, maximum: 1e12 }]),
      ),
    },
  };
  const session = [{ browserSession: [] }];
  return {
    openapi: "3.2.1",
    info: {
      title: "Breadcrumb API",
      version: "1.0.0",
      description:
        "Permissioned access to your own estimated activity and screenshots. Time is observed sampled coverage, not verified productive work. Public-profile leaderboard participation is on by default and can be disabled.",
    },
    servers: [{ url: base }],
    externalDocs: { url: base + "/docs" },
    security: [{ oauth: ["time:read"] }],
    paths: {
      "/api/v1/agents/usage": {
        get: {
          operationId: "getAgentUsage",
          summary: "Read your private coding-agent usage",
          description:
            "Hourly token aggregates only. No chats, session IDs or paths. Unknown models remain unpriced. Sessions count starts in each hour. Excluded from public profiles and leaderboards.",
          security: [{ oauth: ["agents:read"] }, { browserSession: [] }],
          parameters: [
            param(
              "range",
              { type: "integer", enum: [1, 7, 30, 90], default: 7 },
              "Past days; 1 means past 24h. Boundaries have hourly precision.",
            ),
            param("timeZone", { type: "string", default: "UTC" }, "Viewer IANA time zone."),
          ],
          responses: responses({
            type: "object",
            properties: {
              hours: { type: "array", items: { $ref: "#/components/schemas/AgentHour" } },
              timeZone: { type: "string" },
              sessionsCount: { const: "started" },
              estimate: { const: "API estimate" },
              precision: { const: "hour" },
            },
          }),
        },
      },
      "/v1/agents/ingest": {
        post: {
          operationId: "ingestAgentUsage",
          summary: "Upload hourly token usage",
          description:
            "Requires an agents:sync token for the /v1 resource. Accepts versioned hourly snapshots, up to 24 snapshots and 512 KiB per request. Replaces older revisions for each source and hour; each provider/model/project row is unique within an hour. Unknown fields, chats and paths are rejected.",
          security: [{ oauth: ["agents:sync"] }],
          requestBody: body(
            {
              consent: { const: true },
              snapshots: {
                type: "array",
                minItems: 1,
                maxItems: 24,
                items: { $ref: "#/components/schemas/AgentSnapshot" },
              },
            },
            ["consent", "snapshots"],
          ),
          responses: responses({ type: "object", properties: { accepted: { type: "integer" } } }),
        },
      },
      "/api/v1/activity": {
        get: {
          operationId: "getActivity",
          summary: "Read your daily and hourly activity",
          description:
            "Results contain app usage only with apps:read and project names only with projects:read. Screenshots, window titles, raw text and accessibility trees are never included. Dates are inclusive; follow nextCursor keeping other filters fixed. Maximum range 366 days, maximum page31 days.",
          parameters: [
            param(
              "from",
              { type: "string", format: "date" },
              "First local date; defaults to six days before to.",
            ),
            param(
              "to",
              { type: "string", format: "date" },
              "Last local date; defaults to current UTC date.",
            ),
            param(
              "timeZone",
              { type: "string", default: "UTC" },
              "IANA time zone used to group samples.",
            ),
            param(
              "limit",
              { type: "integer", minimum: 1, maximum: 31, default: 7 },
              "Days per page.",
            ),
            param("cursor", { type: "string", format: "date" }, "The previous nextCursor."),
          ],
          responses: responses({ $ref: "#/components/schemas/ActivityPage" }),
        },
      },
      "/api/v1/screenshots": {
        get: {
          operationId: "listScreenshots",
          summary: "List your own screenshot IDs",
          security: [{ oauth: ["screenshots:read"] }, { browserSession: [] }],
          description:
            "Capture-ID order, 20 records per page. No image bytes, window titles, app names or trees.",
          parameters: [
            param(
              "cursor",
              { type: "string", maxLength: 2048 },
              "Opaque nextCursor from previous page.",
            ),
          ],
          responses: responses({
            type: "object",
            required: ["entries", "nextCursor"],
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "date", "hasScreenshot"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    date: { type: "string", format: "date-time" },
                    hasScreenshot: { type: "boolean" },
                  },
                },
              },
              nextCursor: { type: "string" },
            },
          }),
        },
      },
      "/api/v1/screenshots/{id}/image": {
        get: {
          operationId: "getScreenshot",
          summary: "Read one owned screenshot",
          security: [{ oauth: ["screenshots:read"] }, { browserSession: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Private screenshot, never shared-cacheable",
              content: { "image/jpeg": { schema: { type: "string", format: "binary" } } },
            },
            "401": problem,
            "403": problem,
            "404": problem,
            "429": problem,
            "503": problem,
          },
        },
      },
      "/api/v1/connections": {
        get: {
          operationId: "listConnections",
          summary: "List your app grants",
          security: session,
          responses: responses(object),
        },
        delete: {
          operationId: "disconnectApp",
          summary: "Disconnect an app immediately",
          security: session,
          description:
            "Browser-only action with same-origin protection. Token grants are checked on every data request.",
          requestBody: body({ id: { type: "string" } }, ["id"]),
          responses: responses(object),
        },
      },
      "/api/v1/shares": {
        get: {
          operationId: "listScreenshotShares",
          summary: "List active screenshot links",
          security: session,
          responses: responses(object),
        },
        post: {
          operationId: "shareScreenshot",
          summary: "Create an expiring screenshot link",
          description:
            "Explicit browser action only. Anyone with the resulting URL can view that one image. The secret URL is returned once; expires in1–168hours. No accessibility tree or other captures are shared.",
          security: session,
          requestBody: body(
            {
              captureId: { type: "string", format: "uuid" },
              expiresInHours: { type: "integer", minimum: 1, maximum: 168, default: 24 },
            },
            ["captureId"],
          ),
          responses: responses({
            type: "object",
            required: ["id", "url", "expiresAt"],
            properties: {
              id: { type: "string" },
              url: { type: "string", format: "uri" },
              expiresAt: { type: "string", format: "date-time" },
            },
          }),
        },
        delete: {
          operationId: "revokeScreenshotShare",
          summary: "Revoke a screenshot link",
          security: session,
          requestBody: body({ id: { type: "string" } }, ["id"]),
          responses: responses(object),
        },
      },
      "/api/v1/leaderboard": {
        get: {
          operationId: "getLeaderboard",
          summary: "Rank public profiles by observed time",
          security: [],
          description:
            "Private profiles and opt-outs are excluded. Actual app usage appears only when separately shared. Ranges use UTC calendar dates.",
          parameters: [
            param(
              "range",
              { type: "string", enum: ["7", "30", "all"], default: "7" },
              "Inclusive days, ending today in UTC.",
            ),
            param(
              "limit",
              { type: "integer", minimum: 1, maximum: 50, default: 20 },
              "Rows per page.",
            ),
            param(
              "cursor",
              { type: "string" },
              "Opaque continuation, bound to range and UTC date.",
            ),
          ],
          responses: responses({
            type: "object",
            required: ["range", "entries", "nextCursor", "updatedAt"],
            properties: {
              range: { type: "string" },
              entries: { type: "array", items: { $ref: "#/components/schemas/LeaderboardEntry" } },
              nextCursor: { type: "string" },
              updatedAt: { type: ["string", "null"], format: "date-time" },
            },
          }),
        },
      },
      "/api/v1/leaderboard/preferences": {
        get: {
          operationId: "getLeaderboardPreferences",
          summary: "Read your leaderboard visibility",
          security: session,
          responses: responses(object),
        },
        patch: {
          operationId: "updateLeaderboardPreferences",
          summary: "Hide or share your public-profile time and app usage",
          security: session,
          requestBody: body({ enabled: { type: "boolean" }, shareApps: { type: "boolean" } }),
          responses: responses(object),
        },
      },
      "/api/v1/leaderboard/refresh": {
        post: {
          operationId: "refreshLeaderboard",
          summary: "Index one bounded page of your shared time",
          security: session,
          requestBody: body({ cursor: { type: "string" } }),
          responses: responses({
            type: "object",
            properties: {
              done: { type: "boolean" },
              nextCursor: { type: "string" },
              daysIndexed: { type: "integer" },
            },
          }),
        },
      },
    },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: base + "/api/auth/oauth2/authorize",
              tokenUrl: base + "/api/auth/oauth2/token",
              refreshUrl: base + "/api/auth/oauth2/token",
              scopes: Object.fromEntries(
                Object.entries(permissionLabels).filter(([scope]) => scope !== "captures:sync"),
              ),
            },
          },
        },
        browserSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-better-auth.session_token",
          description: "Browser session cookie. Local HTTP uses the unprefixed cookie name.",
        },
      },
      schemas: {
        AgentRow: agentRow,
        AgentHour: {
          ...agentRow,
          required: [...agentRow.required, "hour"],
          properties: { ...agentRow.properties, hour: { type: "string", format: "date-time" } },
        },
        AgentSnapshot: {
          type: "object",
          additionalProperties: false,
          required: ["source", "hour", "revision", "rows"],
          properties: {
            source: {
              type: "string",
              pattern: "^[a-f0-9]{32}$",
              description: "Stable random library ID; never a hostname or account identity.",
            },
            hour: { type: "string", format: "date-time", description: "UTC hour boundary." },
            revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            rows: {
              type: "array",
              maxItems: 500,
              items: { $ref: "#/components/schemas/AgentRow" },
            },
          },
        },
        Problem: {
          type: "object",
          required: ["type", "title", "status", "code", "detail", "resolution", "instance"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            code: { type: "string" },
            detail: { type: "string" },
            resolution: { type: "string" },
            instance: { type: "string" },
          },
        },
        Breakdown: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "seconds"],
            properties: {
              name: { type: "string" },
              id: { type: "string" },
              seconds: { type: "number", minimum: 0 },
            },
          },
        },
        ActivityPage: {
          type: "object",
          required: ["from", "to", "timeZone", "days", "nextCursor", "measure", "description"],
          properties: {
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
            timeZone: { type: "string" },
            measure: { const: "observed_time" },
            description: { type: "string" },
            nextCursor: { type: "string" },
            days: {
              type: "array",
              items: {
                type: "object",
                required: ["day", "seconds", "hours", "hourly"],
                properties: {
                  day: { type: "string", format: "date" },
                  seconds: { type: "number", minimum: 0 },
                  hours: {
                    type: "array",
                    minItems: 24,
                    maxItems: 24,
                    items: { type: "number", minimum: 0 },
                  },
                  apps: { $ref: "#/components/schemas/Breakdown" },
                  projects: { $ref: "#/components/schemas/Breakdown" },
                  hourly: {
                    type: "array",
                    minItems: 24,
                    maxItems: 24,
                    items: {
                      type: "object",
                      required: ["hour", "seconds"],
                      properties: {
                        hour: { type: "integer", minimum: 0, maximum: 23 },
                        seconds: { type: "number", minimum: 0 },
                        apps: { $ref: "#/components/schemas/Breakdown" },
                        projects: { $ref: "#/components/schemas/Breakdown" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        LeaderboardEntry: {
          type: "object",
          required: ["rank", "username", "displayName", "profileURL", "seconds"],
          properties: {
            rank: { type: "integer" },
            username: { type: "string" },
            displayName: { type: "string" },
            profileURL: { type: "string" },
            avatarURL: { type: "string" },
            seconds: { type: "number", minimum: 0 },
            apps: { $ref: "#/components/schemas/Breakdown" },
          },
        },
      },
    },
  };
}
