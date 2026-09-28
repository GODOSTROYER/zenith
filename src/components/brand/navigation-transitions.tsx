"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { curtainNavigate, productGround } from "@/lib/client/page-curtain";

/** Share the landing's loader across ordinary internal page links. */
export function NavigationTransitions() {
  const router = useRouter();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      // The landing owns hash navigation and its instant waitlist dialog.
      // Hosted previews and downloads retain their native behavior.
      if (!link || link.closest(".zenith-landing, [data-no-transition]") || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || /^(\/preview|\/api|\/auth)(?:\/|$)/.test(url.pathname) || window.location.pathname.startsWith("/preview")) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      const href = url.pathname + url.search + url.hash;
      router.prefetch(href);
      curtainNavigate(href, to => router.push(to), {
        color: url.pathname === "/waitlist" ? "#f7f5ef" : url.pathname === "/" ? "#08090d" : productGround(),
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);
  return null;
}
