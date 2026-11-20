"use client";
import { useEffect, useState, type ReactNode } from "react";
import { BrandIcon } from "../lib/brand";
import { applyTheme, readTheme, themes, type Theme } from "../lib/theme";

export function SiteHeader({ children }: { children?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => setTheme(readTheme()), []);
  return (
    <header>
      <a className="wordmark" href="/" aria-label="Breadcrumb home">
        <BrandIcon size={25} className="brand-icon" />
        Breadcrumb
      </a>
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
        {children}
      </div>
    </header>
  );
}
