import { useMemo, type CSSProperties } from "react";
import { estimatedTime } from "./activity";
import { date, type Capture } from "./types";

/** Today's 24 hours as crumbs that grow with the time recorded in each. */
export function TodayTrail({
  observations,
  byCapture,
}: {
  observations: Capture[];
  byCapture: Map<string, number>;
}) {
  const now = new Date();
  const day = now.toDateString();
  const hours = useMemo(() => {
    const totals = Array<number>(24).fill(0);
    for (const row of observations) {
      const seconds = byCapture.get(row.id);
      const when = date(row.date);
      if (seconds && when.toDateString() === day) totals[when.getHours()] += seconds;
    }
    return totals;
  }, [observations, byCapture, day]);
  const total = hours.reduce((sum, seconds) => sum + seconds, 0);
  const label = total ? `Today, ${estimatedTime(total)} recorded` : "Nothing recorded today yet";
  return (
    <div className="today-trail" role="img" aria-label={label} title={label}>
      {hours.map((seconds, hour) => {
        const share = Math.min(1, seconds / 3600);
        return (
          <i
            key={hour}
            className={hour === now.getHours() ? "now" : undefined}
            style={
              {
                "--t": share,
                "--mix": `${seconds ? 30 + 70 * share : 0}%`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
