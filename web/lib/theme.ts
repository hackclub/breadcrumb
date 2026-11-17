export const themes = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "catppuccin", label: "Catppuccin" },
] as const;
export type Theme = (typeof themes)[number]["value"];
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem("breadcrumb-theme");
    if (themes.some((theme) => theme.value === value)) return value as Theme;
  } catch {
    /* Storage can be unavailable in private or restricted webviews. */
  }
  return "dark";
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("breadcrumb-theme", theme);
  } catch {
    /* Keep this session usable. */
  }
}
// Runs before first paint in Next.js. Keep the whitelist aligned with themes above.
export const themeScript = `try{var t=localStorage.getItem('breadcrumb-theme');document.documentElement.dataset.theme=['light','dark','catppuccin'].includes(t)?t:'dark'}catch{document.documentElement.dataset.theme='dark'}`;
