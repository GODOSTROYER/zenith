"use client";
/**
 * Keeps this server-rendered screen live.
 *
 * The overview reads things the bootstrap payload does not carry (undeployed
 * changesets, security findings, the audit trail), so mirroring it into a
 * client component would mean a second implementation of every number on it.
 * Instead the shell's existing poll is used as a change signal: when the
 * workspace payload actually differs, the server component is re-rendered with
 * fresh data. A deployment moving through its phases therefore updates the
 * cards in place, and there is still exactly one place that computes them.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useShell } from "@/components/shell/shell-context";

export function LiveRefresh() {
  const { boot } = useShell();
  const router = useRouter();
  const seen = useRef<string>("");

  // The whole payload, so a manifest edit counts as a change too, not just a
  // deployment. `useShell` polls; identical responses stringify identically.
  const signature = boot ? JSON.stringify(boot) : "";

  useEffect(() => {
    if (!signature) return;
    if (seen.current && seen.current !== signature) router.refresh();
    seen.current = signature;
  }, [signature, router]);

  return null;
}
