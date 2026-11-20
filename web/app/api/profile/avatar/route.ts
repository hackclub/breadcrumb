import { avatarRoute } from "../../../../lib/profile-avatars";
export const runtime = "nodejs";
export const GET = (request: Request) => avatarRoute(request);
export const POST = (request: Request) => avatarRoute(request);
export const DELETE = (request: Request) => avatarRoute(request);
