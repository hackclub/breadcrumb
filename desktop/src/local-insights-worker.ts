import { localInsights } from "./local-insights";
import type { Capture } from "./types";
self.onmessage = (event: MessageEvent<{ records: Capture[]; timeZone: string }>) => {
  // Dedicated Worker.postMessage uses an empty origin. It is a private parent
  // channel, not a Window message listener; reject synthetic and window messages.
  if (!event.isTrusted || event.origin !== "") return;
  try {
    self.postMessage({ days: localInsights(event.data.records, event.data.timeZone) });
  } catch {
    self.postMessage({ error: "Could not summarize local history." });
  }
};
