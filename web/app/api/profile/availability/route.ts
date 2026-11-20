import { profileRoute } from "../../../../lib/profiles";
export const runtime = "nodejs";
export const GET = (request: Request) => profileRoute(request, "availability");
