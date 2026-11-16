"use client";

import { useEffect } from "react";
import { connectThemeSync } from "@/lib/client/theme-store";

/** Persists across navigation, including routes without a visible theme control. */
export function ThemeSync() {
  useEffect(connectThemeSync, []);
  return null;
}
