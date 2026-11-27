import type { Metadata } from "next";
import localFont from "next/font/local";
import { PerformanceInsights } from "./performance-insights";
import "./style.css";
import "./dashboard.css";
import { themeScript } from "../lib/theme";
export const metadata: Metadata = {
  title: "Breadcrumb",
  other: { "is-agentic-site-type": "app" },
  description: "A little context goes a long way.",
};
// Preloaded; "optional" never swaps fonts after first paint, so text cannot shift.
const familjen = localFont({
  src: "./fonts/familjen-grotesk.woff2",
  weight: "400 700",
  display: "optional",
  variable: "--font-familjen",
});
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={familjen.variable} suppressHydrationWarning>
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
