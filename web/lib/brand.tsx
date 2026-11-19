import type { CSSProperties } from "react";

/** The same unequal crumbs and red indicator used by the macOS menu bar. */
export function BrandIcon({
  size = 24,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className}
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
}
