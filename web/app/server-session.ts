import { headers } from "next/headers";
import { getSessionCookie } from "better-auth/cookies";
import { getAuth } from "../lib/auth";

/** Whether the request has a valid session, so pages render the right header on the server. */
export async function serverSignedIn(): Promise<boolean> {
  const incoming = await headers();
  if (!getSessionCookie(incoming)) return false;
  try {
    return Boolean(await getAuth().api.getSession({ headers: incoming }));
  } catch {
    // Keep the cookie hint if the session store is briefly unreachable.
    return true;
  }
}
