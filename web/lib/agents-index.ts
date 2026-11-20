import { analyticsIndex, type AnalyticsIndex } from "./analytics";
import { R2AgentIndex } from "./agents-r2";
import type { AgentIndex } from "./agents";
import type { Store } from "./store";
let cached: AnalyticsIndex | undefined;
export function agentIndex(store: Store): AgentIndex {
  if (!process.env.ANALYTICS_BACKEND || process.env.ANALYTICS_BACKEND === "r2")
    return new R2AgentIndex(store);
  cached ??= analyticsIndex();
  if (!cached) throw Error("Agent analytics unavailable");
  return cached;
}
