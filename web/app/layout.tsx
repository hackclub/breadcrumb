import type { Metadata } from "next";
import { PerformanceInsights } from "./performance-insights";
import "./style.css";
import "./dashboard.css";
import { themeScript } from "../lib/theme";
export const metadata: Metadata = {
  title: "Breadcrumb",
  other: { "is-agentic-site-type": "app" },
  description: "A little context goes a long way.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <PerformanceInsights />
      </body>
    </html>
  );
}
