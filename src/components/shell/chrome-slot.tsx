"use client";
import { createContext, useContext } from "react";

/** A DOM destination only. Project controls keep their real provider ancestry. */
export const ChromeSlotContext = createContext<HTMLElement | null>(null);
export function useChromeSlot() {
  return useContext(ChromeSlotContext);
}
