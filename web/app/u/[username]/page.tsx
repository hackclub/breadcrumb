import type { Metadata } from "next";
import { ownProfile } from "../../profile-owner";
import { appCatalog } from "../../../lib/app-catalog";
import { PublicProfile, ProfileSettings } from "../../profile-pages";
import { profileRoute } from "../../../lib/profiles";
import { serverSignedIn } from "../../server-session";
import { getLeaderboards, type ProfileStats } from "../../../lib/leaderboards";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Profile · Breadcrumb",
  robots: { index: false, follow: false },
};
// Time and apps come from the leaderboard index, so a profile shows only what its owner shares there.
async function stats(username: string): Promise<ProfileStats | null> {
  try {
    return await getLeaderboards().profileStats(username);
  } catch {
    return null;
  }
}
export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const owner = await ownProfile();
  if (owner?.username === username.toLowerCase()) {
    const [catalog, shared] = await Promise.all([appCatalog(), stats(owner.username)]);
    return <ProfileSettings initialProfile={owner} initialCatalog={catalog} stats={shared} />;
  }
  const response = await profileRoute(
    new Request("http://localhost/api/profiles/" + encodeURIComponent(username)),
    "public",
    username,
  );
  const [value, signedIn, catalog] = await Promise.all([
    response.json(),
    serverSignedIn(),
    appCatalog(),
  ]);
  return (
    <PublicProfile
      signedIn={signedIn}
      profile={value.profile ?? null}
      stats={value.profile ? await stats(value.profile.username) : null}
      catalog={catalog}
      failed={response.status !== 404 && !response.ok}
    />
  );
}
