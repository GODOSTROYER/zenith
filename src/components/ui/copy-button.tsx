"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "./button";

export interface CopyButtonProps extends Omit<ButtonProps, "children" | "onClick"> {
  /** the text placed on the clipboard */
  value: string;
  /** optional visible label next to the icon */
  label?: string;
  /** what was copied, for the tooltip: "Copy URL" */
  what?: string;
}

/** Copies `value`, then shows a check for 1.2s. Announces the result politely. */
export function CopyButton({
  value,
  label,
  what = "to clipboard",
  variant = "ghost",
  size = "sm",
  ...rest
}: CopyButtonProps) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setDone(true);
    } catch {
      setFailed(true);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDone(false);
      setFailed(false);
    }, 1200);
  };

  return (
    <>
      <Button
        {...rest}
        variant={variant}
        size={size}
        onClick={copy}
        aria-label={label ? undefined : `Copy ${what}`}
        title={failed ? "Copy blocked by the browser — select the text and press ⌘/Ctrl+C." : `Copy ${what}`}
        icon={
          done ? (
            <Check className="h-3.5 w-3.5 text-ok" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )
        }
      >
        {label}
      </Button>
      <span aria-live="polite" className="sr-only">
        {done ? "Copied" : failed ? "Copy failed" : ""}
      </span>
    </>
  );
}
