import table from "./model-prices.json";
import type { AgentTokens } from "./agent-usage-types";
type Price = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
};
type Entry = Price | { alias: string; multiplier?: number };
const models = table.models as Record<string, Entry>;
const free: Price = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
export const processedTokens = (t: AgentTokens) => t.input + t.cacheRead + t.cacheWrite + t.output;
// A dated snapshot uses its model's price; "-free" models (OpenCode Zen) cost nothing.
export function price(model: string): Price | null {
  const entry = models[model] ?? models[model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")];
  if (!entry) return model.endsWith("-free") ? free : null;
  if (!("alias" in entry)) return entry;
  const base = models[entry.alias];
  if (!base || "alias" in base) return null;
  const m = entry.multiplier ?? 1;
  return {
    input: base.input * m,
    cacheRead: base.cacheRead * m,
    cacheWrite: base.cacheWrite * m,
    cacheWrite1h: base.cacheWrite1h * m,
    output: base.output * m,
  };
}
export function estimate(t: AgentTokens, model: string) {
  const p = price(model);
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
