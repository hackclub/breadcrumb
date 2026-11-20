import { Screenshots } from "../../../../lib/screenshots";
import { R2Store } from "../../../../lib/store";
import { platformDB } from "../../../../lib/platform-db";
import { problem } from "../../../../lib/api-http";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    return await new Screenshots(new R2Store(), platformDB()).shared((await params).token);
  } catch (error) {
    return problem(error, request);
  }
}
