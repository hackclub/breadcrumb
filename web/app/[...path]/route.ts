import { after } from "next/server";
import { getLeaderboards } from "../../lib/leaderboards";
import { dayOffset } from "../../lib/activity-api";
import { Service } from "../../lib/service";
import { R2Store } from "../../lib/store";
export const runtime = "nodejs";
export const maxDuration = 120;
let service: Service | undefined;
async function handler(req: Request) {
  try {
    service ??= new Service(
      new R2Store(),
      process.env,
      undefined,
      undefined,
      (participant, date) => {
        after(async () => {
          try {
            const day = new Date((date + 978307200) * 1000).toISOString().slice(0, 10);
            await getLeaderboards().refreshDays(
              participant,
              service!.store,
              [dayOffset(day, -1), day, dayOffset(day, 1)],
              service!.analytics,
            );
          } catch {
            console.error("Leaderboard activity refresh failed");
          }
        });
      },
    );
    const response = await service.dispatch(req);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return new Response("Storage configuration unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
export { handler as GET, handler as POST };
