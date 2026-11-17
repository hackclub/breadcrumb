import { useState } from "react";
import { applyTheme, readTheme, themes, type Theme } from "../../web/lib/theme";
export function ThemePicker() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <label className="setting-row">
      <span>Theme</span>
      <select
        aria-label="Theme"
        value={theme}
        onChange={(event) => {
          const value = event.currentTarget.value as Theme;
          applyTheme(value);
          setTheme(value);
        }}
      >
        {themes.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
