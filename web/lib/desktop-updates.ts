import { z } from "zod";

export const updateManifest = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/),
    notes: z.string().max(10000).optional(),
    pub_date: z.iso.datetime({ offset: true }).optional(),
    platforms: z.record(
      z.string().regex(/^(windows|darwin|linux)-(x86_64|aarch64)$/),
      z
        .object({
          url: z.url().refine((value) => {
            const url = new URL(value);
            return url.protocol === "https:" && !url.username && !url.password && !url.hash;
          }, "Update downloads require HTTPS without embedded credentials"),
          signature: z
            .string()
            .trim()
            .min(40)
            .max(8192)
            .regex(/^[A-Za-z0-9+/=\r\n]+$/),
        })
        .strict(),
    ),
  })
  .strict();

export async function loadDesktopUpdateManifest() {
  const url =
    process.env.DESKTOP_UPDATE_MANIFEST_URL ||
    "https://github.com/hackclub/breadcrumb/releases/download/windows-preview/latest.json";
  if (new URL(url).protocol !== "https:") throw Error("Update manifest requires HTTPS");
  const response = await fetch(url, {
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw Error("Update feed is unavailable");
  return response.json();
}

export function desktopUpdateResponse(target: string, arch: string, manifest: unknown) {
  const headers = { "Cache-Control": "public, max-age=300, s-maxage=3600" };
  if (manifest == null) return new Response(null, { status: 204, headers });
  const parsed = updateManifest.safeParse(manifest);
  if (!parsed.success) return new Response("Update feed is unavailable", { status: 503 });
  const platform = parsed.data.platforms[`${target}-${arch}`];
  if (!platform) return new Response(null, { status: 204, headers });
  const { version, notes, pub_date } = parsed.data;
  return Response.json({ version, notes, pub_date, ...platform }, { headers });
}
