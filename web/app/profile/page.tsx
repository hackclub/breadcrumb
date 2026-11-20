import type { Metadata } from "next";
import { headers } from "next/headers";
import { getSessionCookie } from "better-auth/cookies";
import { ProfileSettings } from "../profile-pages";
export const metadata: Metadata = {
  title: "Your profile · Breadcrumb",
  robots: { index: false, follow: false },
};
export default async function Page() {
  // Layout hint only; the profile API verifies the Better Auth session.
  const initialSignedIn = Boolean(getSessionCookie(await headers()));
  return <ProfileSettings initialSignedIn={initialSignedIn} />;
}
