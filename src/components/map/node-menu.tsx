"use client";
/**
 * The node's own menu. A positioned list, not a modal: it must not lock the
 * page or trap focus behind a three-item shortcut — which is why the kit's
 * Popover, anchored to a trigger, cannot be used here.
 */
import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

export interface NodeMenuProps {
  x: number;
  y: number;
  name: string;
  canRemove: boolean;
  onInspect: () => void;
  onConnect: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function NodeMenu({
  x,
  y,
  name,
  canRemove,
  onInspect,
  onConnect,
  onRemove,
  onClose,
}: NodeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Focus lands on the first item once, on open — not on every re-render, which
  // would drag it back off whichever item the user had arrowed to.
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  /** role="menu" promises arrow keys, so it has them. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  // Keep it on screen: a right-click near the bottom edge would otherwise open
  // a menu nobody can reach.
  const left = Math.min(x, (typeof window === "undefined" ? 1200 : window.innerWidth) - 210);
  const top = Math.min(y, (typeof window === "undefined" ? 800 : window.innerHeight) - 140);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${name}`}
      onKeyDown={onKeyDown}
      style={{ position: "fixed", left, top }}
      className="animate-enter z-50 w-[200px] overflow-hidden rounded-card border border-line bg-bg3 py-1 shadow-overlay"
    >
      <NodeMenuItem onClick={onInspect}>Inspect</NodeMenuItem>
      <NodeMenuItem onClick={onConnect}>Connect from here</NodeMenuItem>
      <NodeMenuItem
        onClick={onRemove}
        danger
        disabled={!canRemove}
        title={
          canRemove
            ? undefined
            : `${name} is already staged for removal — it is in the Changes panel, waiting for a deploy.`
        }
        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        Remove
      </NodeMenuItem>
    </div>
  );
}

/**
 * Not the kit's MenuItem: this one has a danger variant and sits at cursor
 * coordinates rather than under a Popover trigger. Deliberately module-local.
 */
function NodeMenuItem({
  children,
  onClick,
  danger,
  disabled,
  title,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
        "disabled:cursor-not-allowed disabled:opacity-55",
        danger ? "text-err hover:bg-err-dim" : "text-ink hover:bg-bg2",
      ].join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}
