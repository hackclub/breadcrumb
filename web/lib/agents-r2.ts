import type { Store } from "./store";
import type { AgentIndex, AgentSnapshot } from "./agents";
export class R2AgentIndex implements AgentIndex {
  constructor(private store: Store) {}
  async writeAgents(participant: string, snapshots: AgentSnapshot[]) {
    for (const s of snapshots) {
      const key = `agents/v1/${participant}/${s.hour.slice(0, 10)}/${s.source}/${s.hour}.json`;
      await this.store.update(key, (raw) => {
        const old = raw ? (JSON.parse(Buffer.from(raw).toString()) as AgentSnapshot) : null;
        return old && old.revision >= s.revision ? raw : Buffer.from(JSON.stringify(s));
      });
    }
  }
  async readAgents(participant: string, from: string, to: string) {
    const result: AgentSnapshot[] = [];
    const dates: string[] = [];
    for (let t = Date.parse(from.slice(0, 10) + "T00:00:00Z"); t <= Date.parse(to); t += 86400000)
      dates.push(new Date(t).toISOString().slice(0, 10));
    for (let n = 0; n < dates.length; n += 8)
      await Promise.all(
        dates.slice(n, n + 8).map(async (day) => {
          let cursor = "";
          do {
            const page = await this.store.list(`agents/v1/${participant}/${day}/`, cursor, 500);
            for (let k = 0; k < page.keys.length; k += 8)
              await Promise.all(
                page.keys.slice(k, k + 8).map(async (key) => {
                  const raw = await this.store.get(key);
                  if (raw) {
                    const s = JSON.parse(Buffer.from(raw).toString()) as AgentSnapshot;
                    if (s.hour >= from && s.hour <= to) result.push(s);
                  }
                }),
              );
            cursor = page.cursor;
          } while (cursor);
        }),
      );
    return result;
  }
}
