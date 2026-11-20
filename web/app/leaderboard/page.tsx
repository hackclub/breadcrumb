import type { Metadata } from "next";
import { SiteHeader } from "../site-header";
import { serverSignedIn } from "../server-session";
import { Leaderboard } from "./leaderboard";
import "../leaderboard.css";

export const metadata: Metadata = {
  title: "Leaderboard · Breadcrumb",
  description: "A little shared momentum. Explore the community’s shared activity.",
};

export default async function LeaderboardPage() {
  return (
    <main className="portal leaderboard-page">
      <SiteHeader signedIn={await serverSignedIn()} />
      <Leaderboard />
      <footer>
        <span>Keep showing up for the things you care about.</span>
        <a href="/docs">API docs ↗</a>
      </footer>
    </main>
  );
}
