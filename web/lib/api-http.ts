export class APIProblem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public resolution: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function problem(error: unknown, request: Request) {
  const issue =
    error instanceof APIProblem
      ? error
      : new APIProblem(
          503,
          "temporarily_unavailable",
          "This service is temporarily unavailable.",
          "Retry shortly. Contact the operator if this continues.",
        );
  return Response.json(
    {
      type: `https://breadcrumb.hackclub.com/docs#${issue.code}`,
      title: issue.code.replaceAll("_", " "),
      status: issue.status,
      code: issue.code,
      detail: issue.message,
      resolution: issue.resolution,
      instance: new URL(request.url).pathname,
    },
    {
      status: issue.status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
        ...issue.headers,
      },
    },
  );
}
export const apiJSON = (value: unknown, headers: HeadersInit = {}) =>
  Response.json(value, {
    headers: { "Cache-Control": "no-store", Vary: "Authorization, Cookie", ...headers },
  });
export function sameOrigin(request: Request, origin: string) {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new APIProblem(
      403,
      "invalid_origin",
      "This action must originate from Breadcrumb.",
      "Open this page on your Breadcrumb server and retry.",
    );
}
export async function smallJSON(request: Request, maxBytes = 8192) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new APIProblem(
      415,
      "unsupported_media_type",
      "A JSON body is required.",
      "Send Content-Type: application/json.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new APIProblem(
      400,
      "invalid_request",
      "A request body is required.",
      "Send a JSON object.",
    );
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new APIProblem(
          413,
          "payload_too_large",
          "Request exceeds the size limit.",
          "Send a smaller request.",
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof APIProblem) throw error;
    throw new APIProblem(400, "invalid_json", "Invalid JSON body.", "Send a valid JSON object.");
  } finally {
    reader.releaseLock();
  }
}
