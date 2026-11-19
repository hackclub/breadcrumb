"use client";
import { useState } from "react";
import { findApp, type AppEntry } from "../lib/apps";
export function AppIcon({ apps, name, id }: { apps: AppEntry[]; name: string; id?: string }) {
  const [failed, setFailed] = useState("");
  const app = findApp(apps, name, id);
  const icon = app?.icon;
  return icon && /^\/app-icons\/[a-z0-9-]+\.png$/.test(icon) && failed !== icon ? (
    <img
      className="catalog-app-icon"
      src={icon}
      alt=""
      width="22"
      height="22"
      loading="lazy"
      onError={() => setFailed(icon)}
    />
  ) : (
    <span className="app-monogram" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
