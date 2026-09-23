"use client";
/**
 * Every link click on the landing, in one place.
 *
 * - In-page links (#agents, the logo's "/") scroll in place and *replace* the URL's hash, keeping
 *   Next's own history state. A native hash jump pushes a bare history entry the router does not
 *   own, so Back from /login landed on "/#agents" with the sign-in page still on screen.
 * - Links that leave the landing (sign in, sign up, the app, the guide) play the page curtain.
 * - The skip link, modified clicks and new-tab links keep the browser's behaviour.
 */
import { useEffect, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { curtainNavigate, productGround } from "@/lib/client/page-curtain";
import { smoothScroller } from "./landing-motion";

export function useLandingNavigation(root: RefObject<HTMLElement | null>) {
  const router = useRouter();
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || !element.contains(link) || link.target === "_blank" || link.hasAttribute("download") || link.classList.contains("zenith-skip")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;

      const here = url.pathname === window.location.pathname;
      if (here && url.search === window.location.search) {
        // In-page: scroll, and rewrite (never push) the hash.
        event.preventDefault();
        event.stopPropagation();
        const id = decodeURIComponent(url.hash.slice(1));
        const target = id && id !== "main" ? document.getElementById(id) : null;
        const lenis = smoothScroller();
        if (lenis) lenis.scrollTo(target ?? 0, { offset: target ? -88 : 0 });
        else if (target) target.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
        window.history.replaceState(window.history.state, "", target ? `#${id}` : url.pathname + url.search);
        return;
      }

      // Leaving the landing: the curtain, in the ground colour of the page it opens.
      event.preventDefault();
      event.stopPropagation();
      const href = url.pathname + url.search + url.hash;
      router.prefetch(href);
      curtainNavigate(href, (to) => router.push(to), { color: productGround(), recede: element });
    };
    // Capture, so the decision is made before Next's <Link> and the smooth scroller see the click.
    element.addEventListener("click", onClick, true);
    return () => element.removeEventListener("click", onClick, true);
  }, [root, router]);
}
