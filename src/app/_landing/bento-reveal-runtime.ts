/** One-shot, interruptible art direction. Product state and looping scenes are not owned here. */
export const BENTO_REVEAL = { surface: 360, heading: 460, art: 620, stagger: 55, maxDelay: 110 } as const;

/**
 * Keep the card box stationary: moving a parent while a selector measures its pill
 * creates mismatched coordinate spaces. Only the heading and artwork settle in.
 * Everything is readable before JS, and interaction immediately finishes the reveal.
 */
export function installBentoReveal(root: HTMLElement): () => void {
  if (typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined") return () => undefined;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const forced = window.matchMedia("(forced-colors: active)");
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-bento]"));
  const seen = new WeakSet<Element>();
  const active = new Map<HTMLElement, Set<Animation>>();
  let disposed = false;
  const allowed = () => !disposed && !reduced.matches && !forced.matches && !document.hidden;
  const settle = (card: HTMLElement) => {
    const animations = active.get(card);
    active.delete(card);
    // Snapshot ownership before callbacks run; cancel events may mutate the set.
    const pending = animations ? [...animations] : [];
    animations?.clear();
    pending.forEach((animation) => animation.cancel());
  };
  const play = (card: HTMLElement, target: Element | null, keyframes: Keyframe[], duration: number, delay: number) => {
    if (!target || !target.isConnected || typeof target.animate !== "function" || !allowed()) return;
    const animation = target.animate(keyframes, {
      duration, delay, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards",
    });
    const animations = active.get(card) ?? new Set<Animation>();
    active.set(card, animations);
    animations.add(animation);
    const release = () => {
      animations.delete(animation);
      if (active.get(card) === animations && animations.size === 0) active.delete(card);
    };
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
    // DOM order, not observer delivery order; row mates get a small, bounded offset.
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
    if (!allowed()) for (const card of active.keys()) settle(card);
    else cards.forEach((card) => observer.observe(card));
  };
  const interact = (event: Event) => {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-bento]") : null;
    if (card && root.contains(card)) { seen.add(card); settle(card); }
  };
  policy();
  // Capture native focus before nested widgets can stop a bubbling focusin.
  root.addEventListener("focus", interact, true);
  root.addEventListener("focusin", interact);
  root.addEventListener("pointerdown", interact, { passive: true });
  document.addEventListener("visibilitychange", policy);
  [reduced, forced].forEach((media) => media.addEventListener("change", policy));
  return () => {
    disposed = true;
    observer.disconnect();
    for (const card of active.keys()) settle(card);
    root.removeEventListener("focus", interact, true);
    root.removeEventListener("focusin", interact);
    root.removeEventListener("pointerdown", interact);
    document.removeEventListener("visibilitychange", policy);
    [reduced, forced].forEach((media) => media.removeEventListener("change", policy));
  };
}
