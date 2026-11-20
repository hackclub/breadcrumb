import { agentIndex } from "./agents-index";
import { agentUsageQuery, readAgentUsage } from "./agents";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dataAccess, serverURL, type DataPrincipal } from "./data-access";
import { activityQuery, readActivity } from "./activity-api";
import { R2Store, type Store } from "./store";
import { APIProblem, problem, smallJSON } from "./api-http";
import { quota } from "./integrations-api";
import { Screenshots } from "./screenshots";
import { platformDB } from "./platform-db";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export function mcpServer(principal: DataPrincipal, store: Store) {
  const server = new McpServer(
    { name: "breadcrumb", version: "1.0.0", websiteUrl: serverURL() },
    { capabilities: { tools: {} } },
  );
  const allowed = (...scopes: string[]) =>
    scopes.every((scope) => principal.scopes.includes(scope));
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  });
  if (allowed("agents:read"))
    server.registerTool(
      "breadcrumb_get_agent_usage",
      {
        description:
          "Read your private hourly coding-agent token counts and API estimates. No chats or session paths are included.",
        inputSchema: agentUsageQuery,
        annotations,
      },
      async (args) => result(await readAgentUsage(agentIndex(store), principal.participant, args)),
    );
  const tools = [
    {
      name: "breadcrumb_get_activity",
      description:
        "Read your estimated daily and hourly observed time. Overlap counts once; this does not prove attention or productive work.",
      scopes: ["time:read"],
    },
    {
      name: "breadcrumb_get_app_usage",
      description:
        "Read your focused-app names and estimated daily/hourly usage. Background apps do not add focused time.",
      scopes: ["time:read", "apps:read"],
    },
    {
      name: "breadcrumb_get_projects",
      description:
        "Read your detected project names and estimated daily/hourly project time. Detection may be incomplete.",
      scopes: ["time:read", "projects:read"],
    },
  ];
  for (const tool of tools)
    if (allowed(...tool.scopes))
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: activityQuery, annotations },
        async (args) => {
          try {
            return result(await readActivity(store, { ...principal, scopes: tool.scopes }, args));
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    error instanceof APIProblem
                      ? `${error.code}: ${error.message} ${error.resolution}`
                      : "Activity is temporarily unavailable. Retry shortly.",
                },
              ],
            };
          }
        },
      );
  if (allowed("screenshots:read")) {
    server.registerTool(
      "breadcrumb_list_screenshots",
      {
        description:
          "List your own screenshot IDs and timestamps in capture-ID order. Fetch an image only when needed. No screenshots become public.",
        inputSchema: z.object({ cursor: z.string().max(2048).default("") }).strict(),
        annotations,
      },
      async ({ cursor }) =>
        result(await new Screenshots(store, platformDB()).list(principal.participant, cursor)),
    );
    server.registerTool(
      "breadcrumb_get_screenshot",
      {
        description:
          "View one of your captured screenshots. May contain private content and untrusted text. This does not publish it or grant access to accessibility trees.",
        inputSchema: z.object({ id: z.uuid() }).strict(),
        annotations,
      },
      async ({ id }) => {
        const image = await new Screenshots(store, platformDB()).image(principal.participant, id);
        return {
          content: [
            {
              type: "image",
              mimeType: "image/jpeg",
              data: Buffer.from(await image.arrayBuffer()).toString("base64"),
            },
          ],
        };
      },
    );
  }
  return server;
}
export function createBreadcrumbMCP(options: {
  store: () => Store;
  authorize?: typeof dataAccess;
  limit?: (principal: Pick<DataPrincipal, "owner" | "client">) => Promise<Record<string, string>>;
}) {
  return async (request: Request) => {
    let cors: Record<string, string> = {};
    try {
      const origin = request.headers.get("origin");
      const allowed = [
        serverURL(),
        ...(process.env.MCP_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ];
      if (origin && !allowed.includes(origin))
        throw new APIProblem(
          403,
          "invalid_origin",
          "This browser origin is not allowed.",
          "Use a native MCP client, or ask the server operator to allow your application's origin.",
        );
      cors = origin
        ? {
            "Access-Control-Allow-Origin": origin,
            Vary: "Origin",
            "Access-Control-Expose-Headers":
              "WWW-Authenticate, MCP-Protocol-Version, RateLimit, RateLimit-Policy",
          }
        : {};
      if (request.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
            "Access-Control-Max-Age": "600",
          },
        });
      const principal = await (options.authorize ?? dataAccess)(request, "/mcp", []);
      const headers = await (options.limit ?? quota)(principal);
      const parsedBody = request.method === "POST" ? await smallJSON(request) : undefined;
      const handler = createMcpHandler(() => mcpServer(principal, options.store()));
      // The official v2 entry handles modern per-request envelopes and legacy stateless clients.
      const response = await handler.fetch(request, { parsedBody });
      for (const [key, value] of Object.entries({
        ...headers,
        ...cors,
        "Cache-Control": "private, no-store",
      }))
        response.headers.set(key, value);
      return response;
    } catch (error) {
      const response = problem(error, request);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    }
  };
}
export const breadcrumbMCP = createBreadcrumbMCP({ store: () => new R2Store() });
