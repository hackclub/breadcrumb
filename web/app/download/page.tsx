import { SiteHeader } from "../site-header";

const release = "https://github.com/hackclub/breadcrumb/releases/download/windows-preview/";
export default function DownloadPage() {
  return (
    <main className="portal download-page">
      <SiteHeader>
        <a href="/">Dashboard</a>
      </SiteHeader>
      <section className="download-content">
        <h1>Breadcrumb for your desktop</h1>
        <p className="muted">
          Your history, on your device. Record and explore your time without an account. Sign in
          whenever you want to sync.
        </p>
        <div className="download-options">
          <a className="download-option" href={release + "Breadcrumb-macOS-Apple-Silicon.dmg"}>
            <span>
              <strong>macOS</strong>
              <small>Preview · Apple Silicon · M1 or newer</small>
            </span>
            <span>Download ↓</span>
          </a>
          <a className="download-option" href={release + "Breadcrumb-macOS-Intel.dmg"}>
            <span>
              <strong>macOS</strong>
              <small>Preview · Intel</small>
            </span>
            <span>Download ↓</span>
          </a>
          <a className="download-option" href={release + "Breadcrumb-Windows-x64-setup.exe"}>
            <span>
              <strong>Windows</strong>
              <small>64-bit installer</small>
            </span>
            <span>Download ↓</span>
          </a>
        </div>
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
