import type { Metadata } from "next";
import { serverSignedIn } from "../server-session";
import { ProfileSettings } from "../profile-pages";
import { ownProfile } from "../profile-owner";
import { appCatalog } from "../../lib/app-catalog";
import { redirect } from "next/navigation";
export const metadata: Metadata = {
  title: "Your profile · Breadcrumb",
  robots: { index: false, follow: false },
};
export default async function Page() {
  const initialSignedIn = await serverSignedIn();
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
