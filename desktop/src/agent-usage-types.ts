export type AgentTokens = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
};
export type AgentHour = AgentTokens & {
  provider: string;
  model: string;
  project: string;
  hour: string;
  events: number;
};
export type AgentStatus = {
  providers: { id: string; name: string; detected: boolean; enabled: boolean }[];
  lastScan: string;
  pending: number;
  bytes: number;
  error?: string;
};
export type AgentUsage = {
  status: AgentStatus;
  hours: AgentHour[];
  sessions: {
    provider: string;
    id: string;
    parent?: string;
    model: string;
    project: string;
    start: string;
    end: string;
    events: number;
  }[];
  timeZone: string;
};
