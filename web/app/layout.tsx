import type { Metadata } from "next";
import "./style.css";
import { themeScript } from "../lib/theme";
export const metadata: Metadata = {
  title: "Breadcrumb",
  description: "A little context goes a long way.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
