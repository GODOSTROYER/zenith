/** Progressive, presentation-only motion. Never owns product state or calls an API. */
export const MICRO_MOTION = {
  change: 240,
  select: 320,
  trace: 560,
  feedback: 160,
  ease: "cubic-bezier(.2,.75,.25,1)",
} as const;

/** One controller per bento body, not one pointer/visibility listener per card. */
export function installBentoMicro(root: HTMLElement): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const forced = window.matchMedia("(forced-colors: active)");
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-bento]"));
  const groups = Array.from(root.querySelectorAll<HTMLElement>("[data-micro-group]"));
  const values = new WeakMap<Element, string | null>();
  const active = new Map<Element, Animation>();
  let disposed = false;
  let frame = 0;
  let point: { card: HTMLElement; x: number; y: number } | null = null;
  let hovered: HTMLElement | null = null;
  let focused: HTMLElement | null = null;

  const allowed = () => !disposed && !reduced.matches && !forced.matches && !document.hidden;
  const visible = (element: Element) => {
    const rect = (element instanceof SVGElement ? element.ownerSVGElement ?? element : element).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  };
  const stop = (element: Element) => {
    const animation = active.get(element);
    active.delete(element);
    animation?.cancel();
  };
  const play = (element: Element, keyframes: Keyframe[], duration: number) => {
    stop(element);
    if (!allowed() || !element.isConnected || !visible(element) || typeof element.animate !== "function") return;
    const animation = element.animate(keyframes, { duration, easing: MICRO_MOTION.ease });
    active.set(element, animation);
    const release = () => { if (active.get(element) === animation) active.delete(element); };
    animation.onfinish = release;
    animation.oncancel = release;
  };
  const clearPointer = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    point = null;
    if (hovered) {
      delete hovered.dataset.microHover;
      hovered.style.removeProperty("--micro-x");
      hovered.style.removeProperty("--micro-y");
    }
    hovered = null;
  };
  const cardFor = (target: EventTarget | null) => {
    const card = target instanceof Element ? target.closest<HTMLElement>("[data-bento]") : null;
    return card && root.contains(card) ? card : null;
  };
  const paintPointer = () => {
    frame = 0;
    if (!point || !allowed() || !fine.matches) return;
    const { card, x, y } = point;
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    card.style.setProperty("--micro-x", `${Math.max(0, Math.min(rect.width, x - rect.left))}px`);
    card.style.setProperty("--micro-y", `${Math.max(0, Math.min(rect.height, y - rect.top))}px`);
    card.dataset.microHover = "true";
  };
  const pointer = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || !fine.matches || !allowed()) { clearPointer(); return; }
    const card = cardFor(event.target);
    if (!card) { clearPointer(); return; }
    if (hovered !== card) { clearPointer(); hovered = card; }
    point = { card, x: event.clientX, y: event.clientY };
    if (!frame) frame = window.requestAnimationFrame(paintPointer);
  };
  const pointerOut = (event: PointerEvent) => {
    if (cardFor(event.relatedTarget) !== hovered) clearPointer();
  };
  const focus = (event: FocusEvent) => {
    if (focused) delete focused.dataset.microFocus;
    focused = cardFor(event.target);
    if (focused) focused.dataset.microFocus = "true";
  };
  const blur = (event: FocusEvent) => {
    if (focused && cardFor(event.relatedTarget) !== focused) {
      delete focused.dataset.microFocus;
      focused = null;
    }
  };

  const positionPill = (group: HTMLElement, animate: boolean) => {
    const pill = group.querySelector<HTMLElement>("[data-micro-pill]");
    const selected = group.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!pill || !selected || reduced.matches || forced.matches) {
      delete group.dataset.microReady;
      if (pill) stop(pill);
      return;
    }
    const wasReady = group.dataset.microReady === "true";
    // Read the in-flight position before cancellation, so rapid selection never jumps back.
    const before = pill.getBoundingClientRect();
    const parent = group.getBoundingClientRect();
    const x = selected.offsetLeft;
    const y = selected.offsetTop;
    const width = selected.offsetWidth;
    const height = selected.offsetHeight;
    if (!width || !height) return; // Native button backgrounds remain the fallback.
    stop(pill);
    pill.style.width = `${width}px`;
    pill.style.height = `${height}px`;
    pill.style.transform = `translate(${x}px, ${y}px)`;
    group.dataset.microReady = "true";
    if (animate && wasReady && before.width && before.height) {
      play(pill, [
        { transform: `translate(${before.left - parent.left - group.clientLeft}px, ${before.top - parent.top - group.clientTop}px) scale(${before.width / width}, ${before.height / height})` },
        { transform: `translate(${x}px, ${y}px) scale(1, 1)` },
      ], MICRO_MOTION.select);
    }
  };
  const change = (element: HTMLElement) => {
    const next = element.getAttribute("data-micro-value");
    const previous = values.get(element);
    values.set(element, next);
    if (previous === undefined || previous === next) return;
    if (element.dataset.microChange === "map") {
      if (next?.startsWith("proposed:") && previous?.startsWith("current:")) {
        element.querySelectorAll("button[data-new]").forEach((node) => play(node,
          [{ opacity: .4, translate: "0 6px" }, { opacity: 1, translate: "0 0" }], MICRO_MOTION.select));
      }
      element.querySelectorAll("[data-micro-beam]").forEach((path) => play(path, [
        { strokeDashoffset: "1", opacity: 0 },
        { strokeDashoffset: ".8", opacity: .9, offset: .2 },
        { strokeDashoffset: "0", opacity: .8, offset: .8 },
        { strokeDashoffset: "0", opacity: 0 },
      ], MICRO_MOTION.trace));
      return;
    }
    play(element, [{ opacity: .58, translate: "0 5px" }, { opacity: 1, translate: "0 0" }], MICRO_MOTION.change);
  };

  root.querySelectorAll("[data-micro-change]").forEach((element) => values.set(element, element.getAttribute("data-micro-value")));
  groups.forEach((group) => positionPill(group, false));
  const mutations = new MutationObserver((records) => {
    const changedGroups = new Set<HTMLElement>();
    const changedValues = new Set<HTMLElement>();
    records.forEach((record) => {
      const element = record.target;
      if (!(element instanceof HTMLElement)) return;
      if (record.attributeName === "aria-pressed") {
        const group = element.closest<HTMLElement>("[data-micro-group]");
        if (group) changedGroups.add(group);
      } else if (record.attributeName === "data-micro-value") {
        changedValues.add(element);
      } else if (record.attributeName === "open" && element.hasAttribute("open")) {
        const body = element.querySelector("[data-micro-disclosure]");
        if (body) play(body, [{ opacity: .6, translate: "0 -4px" }, { opacity: 1, translate: "0 0" }], MICRO_MOTION.change);
      }
    });
    changedGroups.forEach((group) => positionPill(group, true));
    changedValues.forEach(change);
  });
  mutations.observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-pressed", "data-micro-value", "open"] });

  const resize = () => groups.forEach((group) => positionPill(group, false));
  const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  groups.forEach((group) => {
    sizes?.observe(group);
    group.querySelectorAll("button").forEach((button) => sizes?.observe(button));
  });
  const visibility = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        for (const element of active.keys()) if (entry.target.contains(element)) stop(element);
        if (entry.target === hovered) clearPointer();
      }
    });
  });
  const policy = () => {
    root.dataset.microPolicy = reduced.matches || forced.matches || document.hidden ? "still" : "ready";
    if (!allowed() || !fine.matches) clearPointer();
    if (!allowed()) for (const element of active.keys()) stop(element);
    visibility?.disconnect();
    if (allowed()) cards.forEach((card) => visibility?.observe(card));
    resize();
  };
  policy();
  root.addEventListener("pointermove", pointer, { passive: true });
  root.addEventListener("pointerout", pointerOut, { passive: true });
  root.addEventListener("pointerleave", clearPointer);
  root.addEventListener("focusin", focus);
  root.addEventListener("focusout", blur);
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", policy);
  [reduced, forced, fine].forEach((media) => media.addEventListener("change", policy));
  void document.fonts?.ready.then(() => { if (!disposed) resize(); });

  return () => {
    disposed = true;
    clearPointer();
    for (const element of active.keys()) stop(element);
    mutations.disconnect();
    sizes?.disconnect();
    visibility?.disconnect();
    root.removeEventListener("pointermove", pointer);
    root.removeEventListener("pointerout", pointerOut);
    root.removeEventListener("pointerleave", clearPointer);
    root.removeEventListener("focusin", focus);
    root.removeEventListener("focusout", blur);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", policy);
    [reduced, forced, fine].forEach((media) => media.removeEventListener("change", policy));
    groups.forEach((group) => {
      delete group.dataset.microReady;
      group.querySelector<HTMLElement>("[data-micro-pill]")?.removeAttribute("style");
    });
    cards.forEach((card) => { delete card.dataset.microFocus; delete card.dataset.microHover; });
    delete root.dataset.microPolicy;
  };
}
