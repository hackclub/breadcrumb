import table from "../../web/lib/model-prices.json";
import type { AgentTokens } from "./agent-usage-types";
export const processedTokens = (t: AgentTokens) => t.input + t.cacheRead + t.cacheWrite + t.output;
export function estimate(t: AgentTokens, model: string) {
  const p = (
    table.models as Record<
      string,
      { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number }
    >
  )[model];
  if (!p) return null;
  return {
    cost:
      (t.input * p.input +
        t.cacheRead * p.cacheRead +
        (t.cacheWrite - t.cacheWrite1h) * p.cacheWrite +
        t.cacheWrite1h * p.cacheWrite1h +
        t.output * p.output) /
      1e6,
    savings: (t.cacheRead * (p.input - p.cacheRead)) / 1e6,
  };
}
