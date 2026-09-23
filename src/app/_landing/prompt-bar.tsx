"use client";

// Adapted from David Haz's React Bits PromptBar: a measured textarea that grows to five lines, and a send control.
import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { ArrowUp } from "lucide-react";
import styles from "./prompt-bar.module.css";

export interface PromptBarProps {
  id: string;
  label: string;
  sendLabel: string;
  placeholder?: string;
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  maxLength?: number;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

export function PromptBar({ id, label, sendLabel, placeholder, value, onValueChange, onSend, disabled = false, maxLength = 500, inputRef }: PromptBarProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const canSend = !disabled && value.trim().length > 0;
  const attach = (element: HTMLTextAreaElement | null) => { own.current = element; if (inputRef) inputRef.current = element; };

  // Upstream's measured textarea expansion, bounded to five lines.
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = "0px";
    const max = 22 * 5;
    el.style.height = `${Math.max(22, Math.min(el.scrollHeight, max))}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value]);

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composing.current) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  return <div className={styles.composer}>
    <label htmlFor={id} className={styles.srOnly}>{label}</label>
    <div className={styles.prompt}>
      <textarea ref={attach} id={id} value={value} placeholder={placeholder} rows={1} maxLength={maxLength}
        disabled={disabled} onChange={(event) => onValueChange(event.target.value)} onKeyDown={keyDown} autoComplete="off"
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      <button type="button" className={styles.send} aria-label={sendLabel} disabled={!canSend} onClick={() => { if (canSend) onSend(); }}>
        <ArrowUp size={18} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
