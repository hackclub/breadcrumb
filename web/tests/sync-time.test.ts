import { test, expect } from "bun:test";
import { recordSynced, syncedSummary } from "../lib/sync";
import { MemoryStore } from "../lib/store";
import { REFERENCE } from "../lib/insights";

test("local days straddling paginated UTC partitions are complete and identical on both pages", async () => {
  class OneDayPage extends MemoryStore {
    async list(prefix: string, cursor = "", _limit = 100) {
      return super.list(prefix, cursor, 1);
    }
  }
  const store = new OneDayPage();
  const instant = Date.parse("2026-11-18T23:59:50Z") / 1000 - REFERENCE;
  for (const [id, date] of [
    ["a", instant],
    ["b", instant + 15],
  ] as const)
    await recordSynced(
      store,
      "person",
      { id, date, app: "Editor", bundleID: "editor", windowTitle: "Synthetic" },
      "2026-11-19T01:00:00Z",
    );
  const first = await syncedSummary(store, "person", "", "America/New_York");
  const second = await syncedSummary(store, "person", first.nextCursor, "America/New_York");
  expect(first.days).toEqual(second.days);
  expect(first.days[0].day).toBe("2026-11-18");
  expect(first.days[0].captures).toBe(2);
  expect(first.days[0].seconds).toBe(45);
  expect(first.days[0].hours[18]).toBe(10);
  expect(first.days[0].hours[19]).toBe(35);
});
