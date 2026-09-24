/** One-shot, interruptible art direction. Product state and looping scenes are not owned here. */
export const BENTO_REVEAL = { surface: 360, heading: 460, art: 620, stagger: 55, maxDelay: 110 } as const;

/** Keep card coordinates stable; only headings and artwork settle in. */
export function installBentoReveal(root: HTMLElement): () => void {
  if (typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined") return () => undefined;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const forced = window.matchMedia("(forced-colors: active)");
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-bento]"));
  const seen = new WeakSet<Element>();
  const active = new Map<Animation, HTMLElement>();
  let disposed = false;
  const allowed = () => !disposed && !reduced.matches && !forced.matches && !document.hidden;
  const settle = (card: HTMLElement) => {
    // Remove all ownership before invoking reentrant cancellation callbacks.
    const pending = [...active].filter(([, owner]) => owner === card).map(([animation]) => animation);
    pending.forEach((animation) => active.delete(animation));
    pending.forEach((animation) => animation.cancel());
  };
  const settleAll = () => {
    const pending = [...active.keys()];
    active.clear();
    pending.forEach((animation) => animation.cancel());
  };
  const play = (card: HTMLElement, target: Element | null, keyframes: Keyframe[], duration: number, delay: number) => {
    if (!target || !target.isConnected || typeof target.animate !== "function" || !allowed()) return;
    const animation = target.animate(keyframes, {
      duration, delay, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards",
    });
    active.set(animation, card);
    const release = () => { active.delete(animation); };
    animation.onfinish = release;
    animation.oncancel = release;
  };
  const observer = new IntersectionObserver((entries) => {
    const incoming: HTMLElement[] = [];
    entries.forEach((entry) => {
      if (!(entry.target instanceof HTMLElement)) return;
      if (!entry.isIntersecting) { settle(entry.target); return; }
      if (!allowed() || seen.has(entry.target) || entry.intersectionRatio < .08) return;
      seen.add(entry.target);
      incoming.push(entry.target);
    });
    incoming.sort((a, b) => cards.indexOf(a) - cards.indexOf(b)).forEach((card, index) => {
      if (card.contains(document.activeElement)) return;
      const delay = Math.min(index * BENTO_REVEAL.stagger, BENTO_REVEAL.maxDelay);
      play(card, card, [{ opacity: .84 }, { opacity: 1 }], BENTO_REVEAL.surface, delay);
      play(card, card.querySelector("h3"), [
        { opacity: .72, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" },
      ], BENTO_REVEAL.heading, delay);
      const art = card.querySelector("[data-bento-art], [data-cloud-scene], [data-agent-loop]");
      play(card, art, [
        { opacity: .76, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" },
      ], BENTO_REVEAL.art, delay + 35);
    });
  }, { threshold: [0, .08] });
  const policy = () => {
    observer.disconnect();
    if (!allowed()) settleAll();
    else cards.forEach((card) => observer.observe(card));
  };
  const interact = (event: Event) => {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-bento]") : null;
    if (card && root.contains(card)) { seen.add(card); settle(card); }
  };
  policy();
  root.addEventListener("focus", interact, true);
  root.addEventListener("focusin", interact);
  root.addEventListener("pointerdown", interact, { passive: true });
  document.addEventListener("visibilitychange", policy);
  [reduced, forced].forEach((media) => media.addEventListener("change", policy));
  return () => {
    disposed = true;
    observer.disconnect();
    settleAll();
    root.removeEventListener("focus", interact, true);
    root.removeEventListener("focusin", interact);
    root.removeEventListener("pointerdown", interact);
    document.removeEventListener("visibilitychange", policy);
    [reduced, forced].forEach((media) => media.removeEventListener("change", policy));
  };
}
