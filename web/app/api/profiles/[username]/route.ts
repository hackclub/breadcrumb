import { profileRoute } from "../../../../lib/profiles";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ username: string }> }) {
  return profileRoute(request, "public", (await context.params).username);
}
