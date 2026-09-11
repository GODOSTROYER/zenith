"use client";
/**
 * "Adopt an external change unless the user is mid-edit."
 *
 * A field whose value can also move underneath it — another tab, the
 * Navigator, another member — has two bad options and one good one. Silently
 * overwriting what is being typed loses the edit; never adopting loses the
 * other person's change. This adopts the new value while the field is
 * untouched, and when it is not, keeps the draft and raises `movedUnderYou`
 * so the screen can say what happened and offer both ways out.
 *
 * The comparison happens during render — the React-documented "adjust state
 * when a prop changes" pattern — so the field never shows one frame of the
 * stale value.
 */
import { useCallback, useState } from "react";

export interface ExternalValue<T, D> {
  /** what the field shows, and what the user types into */
  draft: D;
  setDraft: (next: D) => void;
  /** the external value moved while the draft was dirty; the draft was kept */
  movedUnderYou: boolean;
  /** dismiss the notice, keep the draft */
  acknowledge: () => void;
  /** take the external value as the new draft and dismiss the notice */
  reset: () => void;
  /**
   * Take `value` as both the draft and the last-seen external value — for a
   * save that has already landed, where the next read will return what was
   * just written and must not read as someone else moving the copy.
   */
  adopt: (value: T) => void;
}

export function useExternalValue<T, D>(
  external: T,
  toDraft: (value: T) => D,
  /**
   * Called when the draft adopts the external value during render. For the
   * screen that keeps a companion token (the hash the draft started from)
   * alongside the draft itself.
   */
  onAdopt?: () => void
): ExternalValue<T, D> {
  const [draft, setDraft] = useState<D>(() => toDraft(external));
  const [seen, setSeen] = useState<T>(external);
  const [movedUnderYou, setMovedUnderYou] = useState(false);

  if (seen !== external) {
    const dirty = draft !== toDraft(seen);
    setSeen(external);
    if (dirty) setMovedUnderYou(true);
    else {
      setDraft(toDraft(external));
      onAdopt?.();
    }
  }

  const acknowledge = useCallback(() => setMovedUnderYou(false), []);

  const reset = () => {
    setDraft(toDraft(external));
    setMovedUnderYou(false);
  };

  const adopt = (value: T) => {
    setDraft(toDraft(value));
    setSeen(value);
    setMovedUnderYou(false);
  };

  return { draft, setDraft, movedUnderYou, acknowledge, reset, adopt };
}
