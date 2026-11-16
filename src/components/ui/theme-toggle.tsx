"use client";
import { useCallback, useState } from "react";
import { Check, Eclipse, Monitor, Moon, Sun } from "lucide-react";
import { chooseTheme, useTheme } from "@/lib/client/theme-store";
import type { Theme } from "@/lib/theme";
import { Button, type ButtonSize } from "./button";
import { MenuItem, Popover } from "./popover";

export type { Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun; hint: string }[] = [
  { value: "light", label: "Light", icon: Sun, hint: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  { value: "amoled", label: "AMOLED Dark", icon: Eclipse, hint: "True-black surfaces" },
  { value: "system", label: "System", icon: Monitor, hint: "Follows your OS" },
];

/**
 * All selector instances share the document preference. ThemeSync owns system
 * and storage listeners, so they remain active on routes without a selector.
 */
export function ThemeToggle({ size = "sm" }: { size?: ButtonSize }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const choose = (next: Theme) => {
    chooseTheme(next);
    setOpen(false);
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
          checked={o.value === theme}
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
