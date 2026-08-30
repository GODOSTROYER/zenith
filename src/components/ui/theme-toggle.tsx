"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button, type ButtonSize } from "./button";

export type Theme = "dark" | "light";
const KEY = "orrery-theme";

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: the toggle still works for this session */
  }
}

/**
 * Dark is the default; the choice persists to `orrery-theme` and is applied
 * before paint by the script in app/layout.tsx.
 */
export function ThemeToggle({ size = "sm" }: { size?: ButtonSize }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        apply(next);
        setTheme(next);
      }}
      icon={
        theme === "dark" ? (
          <Sun className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Moon className="h-4 w-4" aria-hidden="true" />
        )
      }
    />
  );
}
