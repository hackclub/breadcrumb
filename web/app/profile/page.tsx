import type { Metadata } from "next";
import { headers } from "next/headers";
import { getSessionCookie } from "better-auth/cookies";
import { ProfileSettings } from "../profile-pages";
import { ownProfile } from "../profile-owner";
import { appCatalog } from "../../lib/app-catalog";
import { redirect } from "next/navigation";
export const metadata: Metadata = {
  title: "Your profile · Breadcrumb",
  robots: { index: false, follow: false },
};
export default async function Page() {
  // Layout hint only; the profile API verifies the Better Auth session.
  const initialSignedIn = Boolean(getSessionCookie(await headers()));
  const profile = await ownProfile();
  if (profile) redirect(`/@${profile.username}`);
  return (
    <ProfileSettings
      initialSignedIn={initialSignedIn}
      initialProfile={profile}
      initialCatalog={await appCatalog()}
    />
  );
}
