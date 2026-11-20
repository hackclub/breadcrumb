export function redactTelemetryURL<T extends { url: string }>(event: T): T | null {
  try {
    const url = new URL(event.url);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    if (/^\/u\/[^/]+\/?$/.test(url.pathname)) url.pathname = "/u/[username]";
    if (/^\/(?:@|%40)[^/]+\/?$/i.test(url.pathname)) url.pathname = "/@[username]";
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}
