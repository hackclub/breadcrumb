export const dataScopes = [
  "time:read",
  "apps:read",
  "projects:read",
  "screenshots:read",
  "agents:read",
] as const;
export type DataScope = (typeof dataScopes)[number];
export const permissionLabels: Record<string, string> = {
  "agents:read": "Read your coding-agent token usage and API estimates",
  "agents:sync": "Upload hourly coding-agent token counts and project names; no chats",
  "screenshots:read": "View your captured screenshots",
  "time:read": "Read estimated time and hourly activity",
  "apps:read": "Read app names and time spent in each app",
  "projects:read": "Read project names and estimated project time",
  "captures:sync":
    "Upload all existing and future captures, including screenshots and accessibility trees",
  email: "Read your email address",
  offline_access: "Keep access until you disconnect this app",
};
