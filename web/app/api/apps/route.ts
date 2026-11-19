import { appCatalog } from "../../../lib/app-catalog";
export const runtime = "nodejs";
export async function GET() {
  return Response.json(
    { apps: await appCatalog() },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
