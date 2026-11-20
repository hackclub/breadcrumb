"use client";
import { useState } from "react";

const release = "https://github.com/hackclub/breadcrumb/releases/download/windows-preview/";
function PlatformIcon({ windows = false }: { windows?: boolean }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {windows ? (
        <path d="M2 4.5 11 3.3v8.2H2zm10-1.3L22 1.8v9.7H12zM2 12.5h9v8.2L2 19.5zm10 0h10v9.7l-10-1.4z" />
      ) : (
        <path d="M17.1 12.7c0-2 1.6-3 1.7-3.1-1-1.5-2.6-1.7-3.2-1.7-1.4-.2-2.7.8-3.4.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.2 9 .8 1.1 1.6 2.3 2.8 2.2 1.1 0 1.6-.7 3-.7s1.9.7 3.1.7c1.3 0 2-1.1 2.7-2.2.9-1.3 1.2-2.6 1.2-2.7-.1 0-2.5-1-2.5-3.7M14.8 6.4c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.7-1.2 1.8-1 2.8 1 .1 2-.5 2.7-1.2" />
      )}
    </svg>
  );
}
export function DownloadOptions() {
  const [intel, setIntel] = useState(false);
  return (
    <div className="download-options">
      <div className="download-option">
        <div className="download-platform">
          <PlatformIcon />
          <div>
            <strong>macOS</strong>
            <small>Preview · macOS 14 or later</small>
          </div>
        </div>
        <div className="download-actions">
          <select
            aria-label="Mac processor"
            value={intel ? "intel" : "silicon"}
            onChange={(event) => setIntel(event.target.value === "intel")}
          >
            <option value="silicon">Apple Silicon</option>
            <option value="intel">Intel</option>
          </select>
          <a
            href={
              release +
              (intel ? "Breadcrumb-macOS-Intel.dmg" : "Breadcrumb-macOS-Apple-Silicon.dmg")
            }
            aria-label={`Download Breadcrumb for macOS ${intel ? "Intel" : "Apple Silicon"}`}
          >
            Download ↓
          </a>
        </div>
      </div>
      <div className="download-option">
        <div className="download-platform">
          <PlatformIcon windows />
          <div>
            <strong>Windows</strong>
            <small>64-bit installer</small>
          </div>
        </div>
        <div className="download-actions">
          <a
            href={release + "Breadcrumb-Windows-x64-setup.exe"}
            aria-label="Download Breadcrumb for Windows"
          >
            Download ↓
          </a>
        </div>
      </div>
    </div>
  );
}
