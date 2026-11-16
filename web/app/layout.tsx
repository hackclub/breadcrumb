import type { Metadata } from "next";
import "./style.css";
export const metadata: Metadata = {
  title: "Breadcrumb",
  description: "A little context goes a long way.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
