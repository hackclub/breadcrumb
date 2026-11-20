import Portal from "./portal";
import { serverSignedIn } from "./server-session";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [signedIn, query] = await Promise.all([serverSignedIn(), searchParams]);
  const initialDesktop =
    typeof query.client_id === "string" && typeof query.sig === "string" ? query.client_id : "";
  return <Portal signedIn={signedIn} initialDesktop={initialDesktop} />;
}
