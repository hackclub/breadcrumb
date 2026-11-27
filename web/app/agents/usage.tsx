"use client";
import { AgentUsageView } from "../agent-usage-view";
import type { AgentUsage, AgentHour } from "../../lib/agent-usage-types";
const names: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};
async function loadUsage(range: number, timeZone: string): Promise<AgentUsage> {
  const response = await fetch(
    "/api/v1/agents/usage?" + new URLSearchParams({ range: String(range), timeZone }),
    { cache: "no-store" },
  );
  if (!response.ok) throw Error("Usage unavailable");
  const result = (await response.json()) as { hours: AgentHour[]; timeZone: string };
  return {
    ...result,
    sessions: [],
    status: {
      providers: [...new Set(result.hours.map((h) => h.provider))].map((id) => ({
        id,
        name: names[id] ?? id,
        enabled: true,
        detected: true,
      })),
      lastScan: "",
      pending: 0,
      bytes: 0,
    },
  };
}
export function AgentsDashboard() {
  return (
    <div style={{ maxWidth: 1040, margin: "40px auto" }}>
      <AgentUsageView loadUsage={loadUsage} remote />
    </div>
  );
}
