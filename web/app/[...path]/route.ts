import { Service } from "../../lib/service";
import { R2Store } from "../../lib/store";
export const runtime = "nodejs";
export const maxDuration = 120;
let service: Service | undefined;
async function handler(req: Request) {
  try {
    service ??= new Service(new R2Store());
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
