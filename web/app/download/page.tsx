import { SiteHeader } from "../site-header";
import { serverSignedIn } from "../server-session";

import { DownloadOptions } from "./download-options";
export default async function DownloadPage() {
  return (
    <main className="portal download-page">
      <SiteHeader signedIn={await serverSignedIn()} />
      <section className="download-content">
        <h1>Breadcrumb for your desktop</h1>
        <p className="muted">
          Your history, on your device. Record and explore your time without an account. Sign in
          whenever you want to sync.
        </p>
        <DownloadOptions />
        <p className="small-note">
          macOS 14 or later. On Mac, drag Breadcrumb into Applications, open it, then allow Screen
          Recording when asked. These Mac previews are signed, with notarization pending. If macOS
          blocks opening the app, allow it in System Settings → Privacy &amp; Security.
        </p>
        <p className="small-note">
          <a href="https://github.com/hackclub/breadcrumb/releases/tag/windows-preview">
            Release notes ↗
          </a>
          <span> · </span>
          <a href="https://github.com/hackclub/breadcrumb#development">Build from source</a>
        </p>
      </section>
    </main>
  );
}
