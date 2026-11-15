"use client";

import { useSyncExternalStore } from "react";
import { applyTheme, parseTheme, THEME_STORAGE_KEY, type ResolvedTheme, type Theme } from "@/lib/theme";

const subscribers = new Set<() => void>();
let connections = 0;
let disconnect: (() => void) | undefined;

function displayedTheme(): ResolvedTheme {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "amoled" ? value : "dark";
}

/** The document is the shared store, including when persistence is unavailable. */
function snapshot(): Theme {
  const applied = parseTheme(document.documentElement.getAttribute("data-theme-preference"));
  if (applied) return applied;
  try {
    const saved = parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
    if (saved) return saved;
  } catch { /* The already-painted document remains authoritative. */ }
  // In particular, retain an unsaved light theme on landing-to-product navigation.
  return displayedTheme();
}

function notify() {
  for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  return () => { subscribers.delete(subscriber); };
}

const serverSnapshot = (): Theme => "dark";

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function chooseTheme(theme: Theme): void {
  applyTheme(theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* This page still switches. */ }
  notify();
}

/** One root lifecycle handles system and other-tab changes on every route. */
export function connectThemeSync(): () => void {
  if (++connections === 1) {
    applyTheme(snapshot());
    notify();

    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      if (event.storageArea) {
        try { if (event.storageArea !== localStorage) return; } catch { return; }
      }
      // Removing or corrupting a preference leaves the currently displayed theme
      // in place instead of unexpectedly changing an open page's appearance.
      const theme = event.key === null ? null : parseTheme(event.newValue);
      applyTheme(theme ?? displayedTheme());
      notify();
    };
    const onSystemChange = () => {
      if (snapshot() === "system") applyTheme("system");
    };
    let media: MediaQueryList | undefined;
    try { media = window.matchMedia?.("(prefers-color-scheme: light)"); } catch { /* Optional API. */ }
    media?.addEventListener?.("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    disconnect = () => {
      media?.removeEventListener?.("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }

  let connected = true;
  return () => {
    if (!connected) return;
    connected = false;
    if (--connections === 0) { disconnect?.(); disconnect = undefined; }
  };
}
