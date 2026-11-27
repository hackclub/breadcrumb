import { expect, test } from "bun:test";
import { calendarClock, REFERENCE } from "../lib/insights";

const formats = new Map<string, Intl.DateTimeFormat>();
function intl(timeZone: string, date: number) {
  if (!formats.has(timeZone))
    formats.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  const parts = Object.fromEntries(
    formats
      .get(timeZone)!
      .formatToParts(new Date((date + REFERENCE) * 1000))
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

test(
  "cached zone offsets match Intl across transitions and unusual offsets",
  { timeout: 60000 },
  () => {
    const zones = [
      "UTC",
      "America/New_York",
      "Europe/London",
      "Australia/Lord_Howe",
      "Pacific/Chatham",
      "Asia/Kathmandu",
      "America/St_Johns",
      "Pacific/Apia",
    ];
    const from = Date.parse("2025-01-01T00:00:00Z") / 1000 - REFERENCE;
    for (const zone of zones) {
      const clock = calendarClock(zone);
      const minutes = (date: number) => {
        const local = intl(zone, date);
        return Date.parse(`${local.day}T00:00:00Z`) / 60000 + local.hour * 60 + local.minute;
      };
      // Coarse samples over two years; every 7.37s across any interval containing a transition.
      for (let date = from, transitions = 0; date < from + 2 * 365 * 86400; date += 1801.37) {
        expect(clock(date)).toEqual(intl(zone, date));
        if (Math.abs(minutes(date + 1801.37) - minutes(date) - 1801.37 / 60) > 1) {
          transitions++;
          for (let dense = date; dense < date + 1801.37; dense += 7.37)
            expect(clock(dense)).toEqual(intl(zone, dense));
        }
        if (
          !["UTC", "Asia/Kathmandu", "Pacific/Apia"].includes(zone) &&
          date + 1801.37 >= from + 2 * 365 * 86400
        )
          expect(transitions).toBeGreaterThan(0);
      }
    }
  },
);
