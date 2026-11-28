import type { CSSProperties } from "react";

/** The three unequal crumbs from the app icon, without its recording light. */
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
      viewBox="5.25 6.25 30 30"
      fill="currentColor"
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="13" cy="13" r="6" />
      <circle cx="29" cy="15" r="4.5" />
      <circle cx="18" cy="31" r="4.5" />
    </svg>
  );
}
