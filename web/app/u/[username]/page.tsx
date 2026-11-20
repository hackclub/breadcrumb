import type { Metadata } from "next";
import { PublicProfile } from "../../profile-pages";
import { profileRoute } from "../../../lib/profiles";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Profile · Breadcrumb",
  robots: { index: false, follow: false },
};
export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const response = await profileRoute(
    new Request("http://localhost/api/profiles/" + encodeURIComponent(username)),
    "public",
    username,
  );
  const value = await response.json();
  return (
    <PublicProfile
      profile={value.profile ?? null}
      failed={response.status !== 404 && !response.ok}
    />
  );
}
