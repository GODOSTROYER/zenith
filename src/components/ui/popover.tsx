"use client";
/**
 * Anchored overlay: the bell panel and every chip menu in the chrome.
 *
 * The overlay behaviour (focus trap, ESC, focus restore) is `useModal` — the
 * same primitive Dialog and Drawer use, so there is one implementation of
 * "an overlay is open" in the kit. What this adds is anchoring to a trigger,
 * outside-click dismissal, and menu semantics with arrow-key roving.
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { cx } from "@/lib/format";
import { useModal } from "./use-modal";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** the control that opens it — it owns its own `aria-expanded` and onClick */
  trigger: ReactNode;
  /** accessible name for the panel */
  label: string;
  /** "menu" adds menu semantics and arrow-key roving over its MenuItems */
  role?: "menu" | "dialog";
  /** which edge of the trigger the panel lines up with */
  align?: "start" | "end";
  width?: number;
  className?: string;
  children: ReactNode;
}

/** Anchored panel with a focus trap, ESC, outside-click and focus restore. */
export function Popover({
  open,
  onClose,
  trigger,
  label,
  role = "menu",
  align = "end",
  width,
  className,
  children,
}: PopoverProps) {
  const box = useRef<HTMLDivElement>(null);
  const { ref, present, shown, isTopmost } = useModal(open, onClose);

  useLayoutEffect(() => {
    const panel = ref.current;
    const anchor = box.current;
    if (!present || !panel || !anchor) return;
    const position = () => {
      const bounds = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const offsetTop = viewport?.offsetTop ?? 0;
      const margin = 12;
      panel.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
      const panelWidth = panel.getBoundingClientRect().width;
      const desiredLeft = align === "end" ? bounds.right - panelWidth : bounds.left;
      panel.style.left = `${Math.max(offsetLeft + margin, Math.min(desiredLeft, offsetLeft + viewportWidth - margin - panelWidth))}px`;
      const below = offsetTop + viewportHeight - bounds.bottom - margin - 8;
      const above = bounds.top - offsetTop - margin - 8;
      const placeAbove = panel.scrollHeight > below && above > below;
      panel.style.maxHeight = `${Math.max(0, placeAbove ? above : below)}px`;
      const height = panel.getBoundingClientRect().height;
      panel.style.top = `${Math.max(offsetTop + margin, placeAbove ? bounds.top - height - 8 : bounds.bottom + 8)}px`;
    };
    position();
    // Modal scroll locking runs after layout; align once more after that can
    // change the trigger's position through scrollbar removal.
    const frame = requestAnimationFrame(position);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(anchor);
    observer?.observe(panel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [present, align, width, ref]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as globalThis.Node;
      if (isTopmost() && !box.current?.contains(target) && !ref.current?.contains(target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose, ref, isTopmost]);

  /** Up/Down/Home/End walk the items, exactly as a menu is expected to. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (role !== "menu") return;
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key) || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
      (el) => el.getAttribute("aria-disabled") !== "true"
    );
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={box} className="relative">
      {trigger}
      {present && createPortal(
        <div
          ref={ref}
          inert={!open}
          role={role}
          aria-modal={role === "dialog" ? true : undefined}
          aria-label={label}
          tabIndex={-1}
          style={width ? { width } : undefined}
          onKeyDown={onKeyDown}
          className={cx(
            "fixed z-50 overflow-y-auto overscroll-contain rounded-card border border-line bg-bg3 shadow-overlay outline-none",
            "transition-[opacity,transform] duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)] motion-reduce:transition-none",
            shown ? "translate-y-0 opacity-100" : "-translate-y-0.5 opacity-0",
            className
          )}
        >
          {children}
        </div>,
        document.body
      )}
    </div>
  );
}

export interface MenuItemProps {
  /** navigates when set; otherwise the item is a button */
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
  /** right-aligned detail: a role, a count, a shortcut */
  hint?: ReactNode;
  /** second line under the label */
  description?: ReactNode;
  disabled?: boolean;
  /** required when disabled — says why, as a tooltip */
  disabledReason?: string;
  type?: "button" | "submit";
  className?: string;
  children: ReactNode;
}

const ROW =
  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink outline-none " +
  "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)] " +
  "hover:bg-bg2 focus-visible:bg-bg2";

/** One row in a Popover menu. Disabled rows still say why, as the kit requires. */
export function MenuItem({
  href,
  onClick,
  icon,
  hint,
  description,
  disabled = false,
  disabledReason,
  type = "button",
  className,
  children,
}: MenuItemProps) {
  const body = (
    <>
      {icon && <span className="shrink-0 text-ink-faint">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block break-words">{children}</span>
        {description && (
          <span className="mt-0.5 block text-[11.5px] text-ink-faint">{description}</span>
        )}
      </span>
      {hint && <span className="shrink-0 text-[11.5px] text-ink-faint">{hint}</span>}
    </>
  );
  const cls = cx(ROW, disabled && "cursor-not-allowed opacity-55", className);

  if (disabled)
    return (
      <span role="menuitem" aria-disabled="true" title={disabledReason} className={cls}>
        {body}
      </span>
    );

  if (href)
    return (
      <Link role="menuitem" href={href} onClick={onClick} className={cls}>
        {body}
      </Link>
    );

  return (
    <button role="menuitem" type={type} onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

/** Non-interactive context at the top of a menu (who you are, what this is). */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-b border-line px-3 py-2 text-[11.5px] leading-relaxed text-ink-faint">
      {children}
    </p>
  );
}
