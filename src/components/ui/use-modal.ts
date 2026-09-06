"use client";
/**
 * Internal overlay plumbing shared by Drawer and Dialog: mount/unmount around
 * the exit transition, focus trap, ESC, scroll lock, focus restore.
 * Not exported from the barrel — use Drawer/Dialog.
 */
import { useEffect, useRef, useState } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const overlays: HTMLDivElement[] = [];
let bodyOverflow = "";

function exitDuration() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const token = getComputedStyle(document.documentElement).getPropertyValue("--dur-base").trim();
  const duration = Number.parseFloat(token);
  return Number.isFinite(duration) ? duration * (token.endsWith("ms") ? 1 : 1000) : 220;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      getComputedStyle(el).visibility !== "hidden" &&
      (el.getClientRects().length > 0 || el === document.activeElement)
  );
}

export function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [present, setPresent] = useState(open);
  const [shown, setShown] = useState(false);
  const close = useRef(onClose);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) {
      // Capture before setPresent mounts controls with React autoFocus.
      opener.current = document.activeElement as HTMLElement | null;
      setPresent(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => setPresent(false), exitDuration());
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open || !mounted || !present) return;
    const restoreTo = opener.current;
    const panel = ref.current;
    if (!panel) return;
    if (overlays.length === 0) {
      bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    overlays.push(panel);
    if (!panel.contains(document.activeElement)) {
      const first = focusables(panel)[0];
      (first ?? panel).focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (overlays.at(-1) !== panel) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = focusables(ref.current);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = ref.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const wasTop = overlays.at(-1) === panel;
      const index = overlays.indexOf(panel);
      if (index !== -1) overlays.splice(index, 1);
      if (overlays.length === 0) document.body.style.overflow = bodyOverflow;
      if (wasTop && restoreTo?.isConnected) restoreTo.focus({ preventScroll: true });
    };
  }, [open, mounted, present]);

  return { ref, present: mounted && present, shown, isTopmost: () => overlays.at(-1) === ref.current };
}
