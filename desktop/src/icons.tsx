import type { CSSProperties } from "react";
export type IconName =
  | "pause"
  | "play"
  | "settings"
  | "close"
  | "back"
  | "chevron"
  | "save"
  | "history"
  | "external"
  | "image"
  | "crumbs";
export function Icon({
  name,
  size = 16,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  if (name === "crumbs")
    return (
      <svg
        className="icon"
        width={size}
        height={size}
        viewBox="0 0 44 44"
        fill="currentColor"
        style={style}
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="13" cy="13" r="6" />
        <circle cx="29" cy="15" r="4.5" />
        <circle cx="18" cy="31" r="4.5" />
        <circle cx="35" cy="35" r="5.5" fill="#ef5555" />
      </svg>
    );
  const paths = {
    pause: (
      <>
        <path d="M9 5v14M15 5v14" />
      </>
    ),
    play: <path d="m9 5 10 7-10 7Z" />,
    settings: (
      <>
        <path d="m9.5 3-.7 2.3-2 .9-2.2-.6-2 3.4 1.7 1.8v2.4L2.6 15l2 3.4 2.2-.6 2 .9.7 2.3h5l.7-2.3 2-.9 2.2.6 2-3.4-1.7-1.8v-2.4L21.4 9l-2-3.4-2.2.6-2-.9L14.5 3Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    back: <path d="m14.5 5-7 7 7 7" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    save: (
      <>
        <path d="M6 20V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v15l-6-4Z" />
        <path d="M9 9h6m-3-3v6" />
      </>
    ),
    history: (
      <>
        <path d="M3.5 10a8.5 8.5 0 1 1 1.8 7.5M3.5 4.5V10H9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6m0-6L10 14" />
        <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8" cy="9" r="1.5" />
        <path d="m3 16 5-4 4 3 4-5 5 6" />
      </>
    ),
  };
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
