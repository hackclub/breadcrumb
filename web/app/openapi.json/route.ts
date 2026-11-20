import { openAPI } from "../../lib/openapi";
export function GET() {
  return Response.json(openAPI(), {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
