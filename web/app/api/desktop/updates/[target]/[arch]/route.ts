import {
  desktopUpdateResponse,
  loadDesktopUpdateManifest,
} from "../../../../../../lib/desktop-updates";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ target: string; arch: string }> },
) {
  const { target, arch } = await params;
  if (!/^(windows|darwin|linux)$/.test(target) || !/^(x86_64|aarch64)$/.test(arch))
    return new Response(null, { status: 404 });
  try {
    return desktopUpdateResponse(target, arch, await loadDesktopUpdateManifest());
  } catch {
    return new Response("Update feed is unavailable", {
      status: 503,
      headers: { "Retry-After": "300" },
    });
  }
}
