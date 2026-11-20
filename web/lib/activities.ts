/** Activity is visible context, never a judgment of productivity or attention. */
export const activities = [
  ["Coding", "Editing source code in an editor or IDE."],
  ["Debugging", "A debugger or explicitly identified debugging context."],
  ["Testing", "Test runners, test results, and automated checks."],
  ["Code review", "Pull requests and merge-request review pages."],
  ["Version control", "Repository changes, commits, and source control."],
  ["Deployment & operations", "Deployments, hosting consoles, and infrastructure."],
  ["Research & docs", "Documentation, reference material, and research pages."],
  ["AI collaboration", "An AI assistant or coding-agent conversation."],
  ["Writing", "Documents, notes, and long-form writing."],
  ["Design", "Visual design, prototyping, and illustration tools."],
  ["Planning", "Issue trackers, task boards, and project planning."],
  ["Data & spreadsheets", "Spreadsheets, databases, and data analysis tools."],
  ["Learning", "Explicit course or lesson context; video alone does not imply learning."],
  ["Messaging", "Chat and messaging interfaces."],
  ["Meetings", "A meeting or call interface; presence does not prove participation."],
  ["Email", "Email interfaces."],
  ["Calendar", "Calendars and scheduling."],
  ["Video", "A video page or player; playback and purpose are unverified."],
  ["Music", "A music application; listening is unverified."],
  ["Social", "Social feeds and community pages."],
  ["Shopping", "Shopping and checkout pages."],
  ["Gaming", "Game applications and gaming interfaces."],
  ["Terminal", "Terminal context without enough evidence for a more specific activity."],
  ["Settings", "Application and browser configuration."],
  ["Browsing", "Browser context without enough evidence for a more specific activity."],
  ["Unclassified", "There is not enough context to classify this activity."],
] as const;
const aliases: Record<string, string> = {
  "Terminal work": "Terminal",
  Reading: "Research & docs",
  "Developer page": "Version control",
  "AI assistant page": "AI collaboration",
  "Messaging interface": "Messaging",
  "Meeting app": "Meetings",
  "Email app": "Email",
  "Calendar interface": "Calendar",
  "Video page": "Video",
  "Music app": "Music",
  "Social page": "Social",
  "Browser settings": "Settings",
};
/**
 * Activities that count toward build time: making, checking, or researching something.
 * Communication, entertainment, and context too vague to classify are left out. This is
 * a plain, editable list, not a productivity score.
 */
export const buildActivities: ReadonlySet<string> = new Set([
  "Coding",
  "Debugging",
  "Testing",
  "Code review",
  "Version control",
  "Deployment & operations",
  "Research & docs",
  "AI collaboration",
  "Writing",
  "Design",
  "Planning",
  "Data & spreadsheets",
  "Learning",
  "Terminal",
]);
export const activityName = (name = "Unclassified") =>
  Object.hasOwn(aliases, name) ? aliases[name] : name || "Unclassified";
export const activityDescription = (name: string) =>
  activities.find(([label]) => label === activityName(name))?.[1] ||
  "A label supplied by your capture or review agent.";

/** Small, auditable rules; only focused window metadata is considered. No OCR or network. */
export function classifyActivity(record: Record<string, unknown>) {
  const label = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 200).trim() : undefined;
  const agent = record.agentLabel as { activity?: unknown } | undefined;
  const prior = record.classification as { activity?: unknown } | undefined;
  const explicit = label(record.correction) || label(agent?.activity);
  if (explicit) return activityName(explicit);
  const title = (label(record.windowTitle) || "").toLowerCase();
  const bundle = (label(record.bundleID) || "").toLowerCase();
  const context = record.context as { domain?: unknown } | undefined;
  const domain = (label(context?.domain) || "").toLowerCase().replace(/^www\./, "");
  const host = (...hosts: string[]) => hosts.some((h) => domain === h || domain.endsWith("." + h));
  const old = activityName(label(prior?.activity));
  // Human and agent labels win; metadata rules describe visible context only.
  if (
    host("chatgpt.com", "claude.ai", "chat.deepseek.com", "aistudio.google.com") ||
    /codex|anthropic\.claude|openai\.chat/.test(bundle)
  )
    return "AI collaboration";
  if (
    host(
      "vercel.com",
      "app.netlify.com",
      "dash.cloudflare.com",
      "console.aws.amazon.com",
      "grafana.com",
    )
  )
    return "Deployment & operations";
  if (
    host("linear.app", "trello.com", "app.asana.com") ||
    /linear|thingsmac|omnifocus/.test(bundle)
  )
    return "Planning";
  if (
    host("figma.com", "canva.com") ||
    /figma|sketch|photoshop|illustrator|affinity|blender/.test(bundle)
  )
    return "Design";
  if (
    host("sheets.google.com") ||
    /excel|numbers|tableplus|dbeaver|datagrip/.test(bundle) ||
    title.endsWith(" - google sheets")
  )
    return "Data & spreadsheets";
  if (
    host("docs.google.com", "notion.so", "overleaf.com") ||
    /obsidian|notion|ulysses|iawriter|msword|apple\.iwork\.pages/.test(bundle)
  )
    return "Writing";
  if (
    host("khanacademy.org", "coursera.org", "edx.org", "udemy.com") ||
    /\b(course lesson|course overview)\b/.test(title)
  )
    return "Learning";
  if (
    host(
      "developer.mozilla.org",
      "stackoverflow.com",
      "wikipedia.org",
      "docs.rs",
      "pkg.go.dev",
      "arxiv.org",
    ) ||
    domain.startsWith("docs.") ||
    /\b(documentation|api reference)\b/.test(title)
  )
    return "Research & docs";
  if (host("github.com", "gitlab.com") && /\b(pull request|merge request)\b/.test(title))
    return "Code review";
  if (
    host("github.com", "gitlab.com", "bitbucket.org") ||
    /github\s*desktop|sourcetree|git-fork/.test(bundle)
  )
    return "Version control";
  if (host("mail.google.com", "outlook.live.com") || /apple\.mail|outlook|thunderbird/.test(bundle))
    return "Email";
  if (host("calendar.google.com") || /ical|calendar/.test(bundle)) return "Calendar";
  if (
    host("meet.google.com", "zoom.us", "teams.microsoft.com") ||
    /zoom|msteams|facetime/.test(bundle)
  )
    return "Meetings";
  if (
    host("slack.com", "discord.com", "web.whatsapp.com") ||
    /slack|slick|discord|signal|telegram/.test(bundle)
  )
    return "Messaging";
  if (host("youtube.com", "vimeo.com", "twitch.tv") || /\bvlc\b/.test(bundle)) return "Video";
  if (host("reddit.com", "x.com", "twitter.com", "instagram.com", "bsky.app")) return "Social";
  if (host("amazon.com", "ebay.com", "etsy.com")) return "Shopping";
  if (
    /minecraft|robloxplayer|steam_app|counter[- ]strike/.test(bundle) ||
    /(?:^|[\\/])cs2(?:\.exe)?$/.test(bundle) ||
    /^(?:com\.valvesoftware\.)?steam(?:\.exe| client webhelper)?$/.test(bundle)
  )
    return "Gaming";
  if (["Coding", "Terminal"].includes(old)) {
    if (/\b(debugger|debug console|debug session)\b/.test(title)) return "Debugging";
    if (/\b(pytest|vitest|jest|test results|test runner|go test|cargo test)\b/.test(title))
      return "Testing";
  }
  return old;
}
