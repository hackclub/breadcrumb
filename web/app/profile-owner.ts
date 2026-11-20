import { headers } from "next/headers";
import { getSessionCookie } from "better-auth/cookies";
import { profileRoute, type Profile } from "../lib/profiles";

export async function ownProfile(): Promise<Profile | null | undefined> {
  const incoming = new Headers(await headers());
  if (!getSessionCookie(incoming)) return undefined;
  const response = await profileRoute(
    new Request("http://localhost/api/profile", { headers: incoming }),
    "owner",
  );
  if (!response.ok) return undefined;
  return (await response.json()).profile;
}
