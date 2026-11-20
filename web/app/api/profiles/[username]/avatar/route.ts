import { avatarRoute } from "../../../../../lib/profile-avatars";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ username: string }> }) {
  return avatarRoute(request, (await context.params).username);
}
