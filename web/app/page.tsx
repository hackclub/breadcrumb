import Portal from "./portal";
import { headers } from "next/headers";
import { getSessionCookie } from "better-auth/cookies";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [requestHeaders, query] = await Promise.all([headers(), searchParams]);
  // Layout hint only. Better Auth still verifies the session before loading data.
  const initialDashboard = Boolean(getSessionCookie(requestHeaders));
  const initialDesktop =
    typeof query.client_id === "string" && typeof query.sig === "string" ? query.client_id : "";
  return <Portal initialDashboard={initialDashboard} initialDesktop={initialDesktop} />;
}
