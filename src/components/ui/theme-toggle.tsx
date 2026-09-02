"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Button, type ButtonSize } from "./button";
import { MenuItem, Popover } from "./popover";

export type Theme = "dark" | "light" | "system";

const KEY = "orrery-theme";

/** What "system" resolves to right now. */
function prefersLight(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches === true
  );
}

/** The document only ever encodes "light" — its absence is dark. */
function paint(theme: Theme): void {
  const light = theme === "light" || (theme === "system" && prefersLight());
  const root = document.documentElement;
  if (light) root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

function stored(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "system" ? t : "dark";
  } catch {
    /* private mode: dark is the default, and the toggle still works */
    return "dark";
  }
}

const OPTIONS: { value: Theme; label: string; icon: typeof Sun; hint: string }[] = [
  { value: "light", label: "Light", icon: Sun, hint: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  { value: "system", label: "System", icon: Monitor, hint: "Follows your OS" },
];

/**
 * Dark is the default; the choice persists to `orrery-theme` and is applied
 * before paint by the script in app/layout.tsx. "System" follows
 * `prefers-color-scheme` and keeps following it while the OS setting changes.
 */
export function ThemeToggle({ size = "sm" }: { size?: ButtonSize }) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => setTheme(stored()), []);

  // While "system" is chosen, an OS change repaints without a reload.
  useEffect(() => {
    if (theme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => paint("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const choose = (next: Theme) => {
    paint(next);
    setTheme(next);
    setOpen(false);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice still holds for this page */
    }
  };

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[1];
  const Icon = current.icon;

  return (
    <Popover
      open={open}
      onClose={close}
      label="Theme"
      width={216}
      trigger={
        <Button
          variant="ghost"
          size={size}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Theme: ${current.label}`}
          title={`Theme: ${current.label}`}
          onClick={() => setOpen((o) => !o)}
          icon={<Icon className="h-4 w-4" aria-hidden="true" />}
        />
      }
    >
      {OPTIONS.map((o) => (
        <MenuItem
          key={o.value}
          icon={<o.icon className="h-3.5 w-3.5" aria-hidden="true" />}
          hint={
            o.value === theme ? (
              <Check className="h-3.5 w-3.5 text-signal" aria-label="current" />
            ) : undefined
          }
          description={o.hint}
          onClick={() => choose(o.value)}
        >
          {o.label}
        </MenuItem>
      ))}
    </Popover>
  );
}
