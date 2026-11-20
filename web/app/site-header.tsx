"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { authClient } from "../lib/auth-client";
import { BrandIcon } from "../lib/brand";
import { applyTheme, readTheme, themes, type Theme } from "../lib/theme";

const accountLinks = [
  { href: "/", label: "Dashboard" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "Coding agents" },
  { href: "/connections", label: "Connections" },
  { href: "/profile", label: "Profile" },
];
const publicLinks = [{ href: "/leaderboard", label: "Leaderboard" }];

export function SiteHeader({
  signedIn = false,
  nav = true,
}: {
  /** Session state resolved on the server, so the header renders without a flash. */
  signedIn?: boolean;
  /** Hide navigation and account actions, e.g. on authorization screens. */
  nav?: boolean;
}) {
  const [theme, setTheme] = useState<Theme>("dark"),
    [signingOut, setSigningOut] = useState(false);
  const path = usePathname();
  useEffect(() => setTheme(readTheme()), []);
  const links = signedIn ? accountLinks : publicLinks;
  const current = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
  return (
    <header>
      <a className="wordmark" href="/" aria-label="Breadcrumb home">
        <BrandIcon size={25} className="brand-icon" />
        Breadcrumb
      </a>
      {nav && (
        <nav className="site-nav" aria-label="Main">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={current(link.href) ? "page" : undefined}
            >
              {link.label}
            </a>
          ))}
        </nav>
      )}
      <div className="header-actions">
        <a href="/download" className="download-nav" aria-label="Download Breadcrumb">
          <span className="download-nav-label">Download</span>
          <span className="download-nav-icon" aria-hidden="true">
            ↓
          </span>
        </a>
        <select
          aria-label="Theme"
          value={theme}
          onChange={(event) => {
            const value = event.currentTarget.value as Theme;
            applyTheme(value);
            setTheme(value);
          }}
        >
          {themes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {nav &&
          (signedIn ? (
            <button
              className="quiet"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                const result = await authClient.signOut();
                if (result.error) {
                  setSigningOut(false);
                  alert(result.error.message ?? "Could not sign out");
                  return;
                }
                location.assign("/");
              }}
            >
              Sign out
            </button>
          ) : (
            path !== "/" && (
              <a className="sign-in-nav" href={"/?next=" + encodeURIComponent(path)}>
                Sign in
              </a>
            )
          ))}
      </div>
    </header>
  );
}
