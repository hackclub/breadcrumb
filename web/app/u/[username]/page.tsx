import type { Metadata } from "next";
import { PublicProfile } from "../../profile-pages";
export const metadata: Metadata = {
  title: "Profile · Breadcrumb",
  robots: { index: false, follow: false },
};
export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <PublicProfile username={username} />;
}
