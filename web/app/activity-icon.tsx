export function ActivityIcon({ name, project = false }: { name: string; project?: boolean }) {
  const label = name.toLowerCase();
  const symbol = project
    ? "project"
    : ((
        [
          ["terminal", /terminal/],
          ["code", /developer|coding|version control|code review/],
          ["check", /testing|planning/],
          ["debug", /debugging/],
          ["cloud", /deployment/],
          ["pen", /design|writing/],
          ["data", /data|spreadsheet/],
          ["shop", /shopping/],
          ["game", /gaming/],
          ["message", /messag/],
          ["video", /video/],
          ["meeting", /meeting/],
          ["reading", /reading|research|learning/],
          ["assistant", /assistant|\bai\b/],
          ["music", /music/],
          ["mail", /email|mail/],
          ["calendar", /calendar/],
          ["social", /social/],
          ["settings", /settings/],
          ["browser", /brows/],
        ] as const
      ).find(([, pattern]) => pattern.test(label))?.[0] ?? "unknown");
  const paths = {
    check: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="m7 12 3 3 7-7" />
      </>
    ),
    debug: (
      <>
        <rect x="7" y="7" width="10" height="14" rx="5" />
        <path d="m9 3 3 4 3-4M3 10h4m10 0h4M3 16h4m10 0h4M12 8v12" />
      </>
    ),
    cloud: (
      <>
        <path d="M7 18H6a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10h-1M12 21V11m-4 4 4-4 4 4" />
      </>
    ),
    pen: (
      <>
        <path d="m4 16-1 5 5-1L21 7l-6-6L4 16Zm10-12 6 6M4 16l4 4" />
      </>
    ),
    data: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M3 15h18M9 3v18" />
      </>
    ),
    shop: (
      <>
        <path d="M4 7h16l1 14H3L4 7ZM8 7V5a4 4 0 0 1 8 0v2" />
      </>
    ),
    game: (
      <>
        <path d="M8 7h8c4 0 6 11 4 13-2 2-5-4-8-4s-6 6-8 4C2 18 4 7 8 7Z" />
        <path d="M6 11h6m-3-3v6m7-3h.01m2 3h.01" />
      </>
    ),
    project: (
      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    ),
    unknown: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-1 .8-1.8 1-1.8 2.8M12 17h.01" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />,
    message: <path d="M21 11a8 8 0 0 1-8 8H9l-6 3 2-6a8 8 0 1 1 16-5Z" />,
    video: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m10 8 6 4-6 4Z" />
      </>
    ),
    meeting: (
      <>
        <rect x="2" y="5" width="13" height="14" rx="3" />
        <path d="m15 10 7-4v12l-7-4" />
      </>
    ),
    reading: <path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15" />,
    assistant: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
        <path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z" />
      </>
    ),
    music: (
      <>
        <path d="M10 18V5l10-2v13M10 8l10-2" />
        <ellipse cx="6.5" cy="18" rx="3.5" ry="3" />
        <ellipse cx="16.5" cy="16" rx="3.5" ry="3" />
      </>
    ),
    mail: (
      <>
        <rect x="2" y="4" width="20" height="16" rx="3" />
        <path d="m3 6 9 7 9-7" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M3 10h18M8 3v4m8-4v4M8 14h2m4 0h2m-8 3h2" />
      </>
    ),
    social: (
      <>
        <circle cx="9" cy="8" r="4" />
        <path d="M2 21v-2a7 7 0 0 1 14 0v2M17 4a4 4 0 0 1 0 8m5 9v-2a7 7 0 0 0-4-6" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16M8 4v6m8 4v6" />
        <circle cx="8" cy="7" r="2" />
        <circle cx="16" cy="17" r="2" />
      </>
    ),
    browser: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
  };
  return (
    <span className="category-icon" aria-hidden="true" data-category={symbol}>
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths[symbol]}
      </svg>
    </span>
  );
}
