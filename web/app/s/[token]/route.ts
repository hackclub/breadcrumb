import { Screenshots } from "../../../lib/screenshots";
import { R2Store } from "../../../lib/store";
import { platformDB } from "../../../lib/platform-db";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    await new Screenshots(new R2Store(), platformDB()).resolve(token);
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Shared screenshot · Breadcrumb</title><style>body{margin:0;background:#161a25;color:#eeeae1;font:14px system-ui;padding:24px}main{max-width:1200px;margin:auto}img{display:block;width:100%;height:auto;border-radius:8px}p{color:#aaa}</style><main><h1>Shared screenshot</h1><p>Shared by its owner through Breadcrumb. This link expires and may be revoked.</p><img src="/s/${token}/image" alt="Screenshot shared by its owner"></main></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Security-Policy":
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        },
      },
    );
  } catch {
    return new Response("This screenshot link has expired or is no longer shared.", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
    });
  }
}
