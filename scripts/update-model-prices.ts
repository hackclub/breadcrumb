// Refreshes web/lib/model-prices.json from LiteLLM's public price list, preferring
// each model's first-party API entry. Aliases keep their base model and multiplier.
// Usage: bun scripts/update-model-prices.ts [--add model-id ...]
import { readFileSync, writeFileSync } from "node:fs";

const LIST =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PROVIDERS = ["openai", "anthropic", "xai", "gemini", "inception", "zai"];
const path = new URL("../web/lib/model-prices.json", import.meta.url);

type Rates = {
  input_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  output_cost_per_token?: number;
  litellm_provider?: string;
  source?: string;
};
type Entry = Record<string, number | string>;

const table = JSON.parse(readFileSync(path, "utf8")) as { models: Record<string, Entry> };
const add = process.argv.slice(2).filter((a) => a !== "--add");
const response = await fetch(LIST);
if (!response.ok) throw Error(`LiteLLM price list: HTTP ${response.status}`);
const list = (await response.json()) as Record<string, Rates>;
const today = new Date().toISOString().slice(0, 10);
const perMillion = (n: number) => Math.round(n * 1e6 * 1e6) / 1e6;

function rates(id: string) {
  const keys = [id, ...PROVIDERS.map((p) => `${p}/${id}`)];
  const key = keys.find((k) => {
    const r = list[k];
    return r && (k === id ? PROVIDERS.includes(r.litellm_provider ?? "") : true);
  });
  const r = key ? list[key] : undefined;
  if (!r?.input_cost_per_token || !r.output_cost_per_token) return null;
  const input = perMillion(r.input_cost_per_token);
  const cacheWrite = perMillion(r.cache_creation_input_token_cost ?? r.input_cost_per_token);
  return {
    input,
    cacheRead: perMillion(r.cache_read_input_token_cost ?? r.input_cost_per_token),
    cacheWrite,
    cacheWrite1h: r.cache_creation_input_token_cost_above_1hr
      ? perMillion(r.cache_creation_input_token_cost_above_1hr)
      : cacheWrite,
    output: perMillion(r.output_cost_per_token),
    source: r.source ?? LIST,
    effectiveDate: today,
  };
}

const missing: string[] = [];
for (const id of new Set([...Object.keys(table.models), ...add])) {
  if (table.models[id]?.alias) continue;
  const next = rates(id);
  if (next) table.models[id] = next;
  else missing.push(id);
}
table.models = Object.fromEntries(
  Object.entries(table.models).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(path, JSON.stringify(table, null, 2) + "\n");
if (missing.length) console.log(`No first-party price for: ${missing.join(", ")}`);
