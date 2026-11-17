import { useEffect, useState } from "react";
import { engine } from "./bridge";
const icons = new Map<string, Promise<string>>();
export function AppIcon({
  app,
  bundleID,
  size = 24,
}: {
  app: string;
  bundleID: string;
  size?: number;
}) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    setSrc("");
    if (bundleID) {
      if (!icons.has(bundleID))
        icons.set(
          bundleID,
          engine<{ icon: string }>("appIcon", { bundleID })
            .then(({ icon }) =>
              icon?.startsWith("data:image/png;base64,") && icon.length < 150000 ? icon : "",
            )
            .catch(() => ""),
        );
      void icons.get(bundleID)!.then((value) => {
        if (active) setSrc(value);
      });
    }
    return () => {
      active = false;
    };
  }, [bundleID]);
  return (
    <span
      className="app-icon"
      role="img"
      aria-label={app}
      title={app}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.48) }}
    >
      {src ? <img src={src} alt="" /> : app.slice(0, 1).toUpperCase()}
    </span>
  );
}
