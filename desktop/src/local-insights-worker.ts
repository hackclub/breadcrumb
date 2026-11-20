import { localInsights } from "./local-insights";
import type { Capture } from "./types";
self.onmessage = (event: MessageEvent<{ records: Capture[]; timeZone: string }>) => {
  try {
    self.postMessage({ days: localInsights(event.data.records, event.data.timeZone) });
  } catch {
    self.postMessage({ error: "Could not summarize local history." });
  }
};
