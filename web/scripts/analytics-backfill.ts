import { parseArgs } from "node:util";
import { analyticsIndex, type IndexedSample } from "../lib/analytics";
import { R2Store } from "../lib/store";
import { syncSample } from "../lib/sync";
const { values } = parseArgs({ options: { cursor: { type: "string" } } });
const index = analyticsIndex();
if (!index) throw Error("Choose postgres or clickhouse with ANALYTICS_BACKEND first");
const store = new R2Store();
let cursor = values.cursor ?? "",
  indexed = 0;
try {
  do {
    const page = await store.list("captures/", cursor, 100);
    const rows: IndexedSample[] = [];
    for (let i = 0; i < page.keys.length; i += 5) {
      await Promise.all(
        page.keys.slice(i, i + 5).map(async (key) => {
          const raw = await store.get(key);
          if (!raw) return;
          const entry = JSON.parse(Buffer.from(raw).toString());
          rows.push(syncSample(entry.participant, entry.upload.record, entry.receivedAt));
        }),
      );
    }
    await index.write(rows);
    indexed += rows.length;
    cursor = page.cursor;
    console.log(JSON.stringify({ indexed, nextCursor: cursor }));
  } while (cursor);
} finally {
  await index.close();
}
