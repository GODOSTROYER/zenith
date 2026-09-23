"use client";

/**
 * Motion for the landing, on GSAP with Lenis smooth scrolling. Everything
 * here is decorative: it never gates content, never runs under a
 * reduced-motion preference, and loads its libraries only in the browser.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { gsap as GsapType } from "gsap";

type Gsap = typeof GsapType;
let loader: Promise<Gsap> | null = null;

/** One lazy import for the whole page; ScrollTrigger registered once. */
function loadGsap(): Promise<Gsap> {
  if (!loader) {
    loader = Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([core, plugin]) => {
      core.gsap.registerPlugin(plugin.ScrollTrigger);
      return core.gsap;
    });
  }
  return loader;
}

/** The core plus MotionPathPlugin, for the light that travels the system diagram. */
let pathLoader: Promise<Gsap> | null = null;
function loadMotionPath(): Promise<Gsap> {
  if (!pathLoader) pathLoader = Promise.all([loadGsap(), import("gsap/MotionPathPlugin")]).then(([gsap, plugin]) => { gsap.registerPlugin(plugin.MotionPathPlugin); return gsap; });
  return pathLoader;
}

const MOTION_OK = "(prefers-reduced-motion: no-preference)";

/**
 * Run `build` with gsap inside a reduced-motion-aware matchMedia scope.
 * Returns the effect cleanup. Nothing runs when the preference is "reduce".
 */
function withGsap(build: (gsap: Gsap) => void | (() => void), load: () => Promise<Gsap> = loadGsap): () => void {
  let cancelled = false;
  let context: { revert: () => void } | null = null;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  load().then((gsap) => {
    if (cancelled) return;
    const mm = gsap.matchMedia();
    mm.add(MOTION_OK, () => build(gsap));
    context = mm;
  }).catch(() => { /* The page reads the same without motion. */ });
  return () => { cancelled = true; context?.revert(); };
}

/** Smooth, inertial scrolling for the whole page, driven by the GSAP ticker so ScrollTrigger stays in step. */
export function useSmoothScroll() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia(MOTION_OK).matches) return;
    let cancelled = false;
    let dispose = () => {};
    Promise.all([loadGsap(), import("lenis"), import("gsap/ScrollTrigger")]).then(([gsap, { default: Lenis }, { ScrollTrigger }]) => {
      if (cancelled) return;
      const lenis = new Lenis({ lerp: 0.1, anchors: { offset: -88 } });
      const onScroll = () => ScrollTrigger.update();
      lenis.on("scroll", onScroll);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(500, 33);
      dispose = () => { gsap.ticker.remove(tick); lenis.off("scroll", onScroll); lenis.destroy(); };
    }).catch(() => { /* Native scrolling is fine. */ });
    return () => { cancelled = true; dispose(); };
  }, []);
}

/**
 * Play `build(target)` once, the first time `target` is meaningfully on screen.
 * IntersectionObserver rather than a scroll listener: it fires for smoothed,
 * programmatic and keyboard scrolling alike, and needs no refresh.
 */
function onceVisible(targets: HTMLElement[], play: (target: HTMLElement) => void): () => void {
  if (typeof IntersectionObserver === "undefined") { targets.forEach(play); return () => {}; }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      play(entry.target as HTMLElement);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  targets.forEach((target) => observer.observe(target));
  return () => observer.disconnect();
}

/** Fade-and-rise every `[data-reveal]` under `root` as it scrolls into view, once. */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    return withGsap((gsap) => {
      const targets = Array.from(element.querySelectorAll<HTMLElement>("[data-reveal]"));
      if (!targets.length) return;
      gsap.set(targets, { opacity: 0, y: 24 });
      const batches = new Map<HTMLElement, HTMLElement[]>();
      for (const target of targets) {
        const group = (target.closest("[data-reveal-group]") as HTMLElement | null) ?? element;
        batches.set(group, [...(batches.get(group) ?? []), target]);
      }
      const tweens: ReturnType<typeof gsap.to>[] = [];
      const stop = onceVisible(Array.from(batches.keys()), (group) => {
        tweens.push(gsap.to(batches.get(group) ?? [], { opacity: 1, y: 0, duration: 0.8, ease: "power3.out", stagger: 0.09, overwrite: "auto" }));
      });
      return () => { stop(); tweens.forEach((tween) => tween.kill()); gsap.set(targets, { clearProps: "opacity,transform" }); };
    });
  }, [root]);
}

/**
 * The opening: letters of the wordmark rise one by one, then the welcome line,
 * tagline, actions and marks. On scroll, the sky, stars, ridges and clouds
 * drift at their own depths while the wordmark recedes.
 */
/**
 * The handoff between the two sheets: as the ink sheet rises over the porcelain, the porcelain recedes at a third of
 * the scroll and darkens under it, exactly as the sky does under the porcelain (see `useHeroScene`).
 */
export function useSheetHandoff(paper: RefObject<HTMLElement | null>, ink: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const sheet = paper.current;
    const cover = ink.current;
    if (!sheet || !cover) return;
    return withGsap((gsap) => {
      const dim = sheet.querySelector<HTMLElement>("[data-sheet-dim]");
      const scrub = { trigger: cover, start: "top bottom", end: "top top", scrub: true };
      const tweens = [gsap.to(sheet, { y: () => window.innerHeight * 0.34, ease: "none", scrollTrigger: { ...scrub, invalidateOnRefresh: true } })];
      if (dim) tweens.push(gsap.fromTo(dim, { opacity: 0 }, { opacity: 0.55, ease: "none", scrollTrigger: scrub }));
      return () => tweens.forEach((tween) => { tween.scrollTrigger?.kill(); tween.kill(); });
    });
  }, [paper, ink]);
}

export function useHeroScene(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    return withGsap((gsap) => {
      const letters = Array.from(element.querySelectorAll<SVGPathElement>("[data-letter]"));
      const beacon = element.querySelector<HTMLElement>("[data-hero-beacon]");
      const layers = Array.from(element.querySelectorAll<HTMLElement>("[data-layer]"));
      const wordmark = element.querySelector<HTMLElement>("[data-hero-wordmark]");
      const fading = Array.from(element.querySelectorAll<HTMLElement>("[data-hero-fade]"));
      const dim = element.querySelector<HTMLElement>("[data-hero-dim]");
      const scrub = { trigger: element, start: "top top", end: "bottom top", scrub: true };
      const parallax: ReturnType<typeof gsap.to>[] = [];
      // The scroll-bound fades wait for the entrance to finish and state their own start values, so they
      // never snapshot a half-arrived element and the opening always comes back whole when scrolled up to.
      const armFades = () => {
        if (wordmark) parallax.push(gsap.fromTo(wordmark, { scale: 1, opacity: 1, yPercent: 0 }, { scale: 0.92, opacity: 0, yPercent: -12, ease: "none", immediateRender: false, scrollTrigger: { ...scrub, end: "70% top" } }));
        if (fading.length) parallax.push(gsap.fromTo(fading, { opacity: 1, y: 0 }, { opacity: 0, ease: "none", immediateRender: false, scrollTrigger: { ...scrub, end: "45% top" } }));
      };
      // Every entrant states both ends, so the first rendered frame already matches the stylesheet's waiting
      // pose and nothing blinks when the library arrives; `data-motion` then hands the pose over to the tweens.
      const entrance = gsap.timeline({ defaults: { ease: "power3.out" }, onComplete: armFades });
      if (letters.length) entrance.fromTo(letters, { y: 46, opacity: 0 }, { y: 0, opacity: 1, duration: 1, stagger: 0.07 }, 0.1);
      if (beacon) entrance.fromTo(beacon, { opacity: 0, scaleY: 0.2, transformOrigin: "50% 100%" }, { opacity: 1, scaleY: 1, duration: 1.4 }, 0.2);
      const apex = element.querySelector<HTMLElement>("[data-hero-apex]");
      if (apex) entrance.fromTo(apex, { opacity: 0, scale: 0.4, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.9 }, 1.1);
      element.dataset.motion = "gsap";
      // Depth is live from the first frame: the layers drift, the whole opening recedes at a third of the scroll and darkens under the sheet.
      layers.forEach((layer) => parallax.push(gsap.to(layer, { yPercent: Number(layer.dataset.speed ?? 0) * 40, ease: "none", scrollTrigger: scrub })));
      parallax.push(gsap.to(element, { yPercent: 34, ease: "none", scrollTrigger: scrub }));
      if (dim) parallax.push(gsap.fromTo(dim, { opacity: 0 }, { opacity: 0.6, ease: "none", scrollTrigger: scrub }));
      return () => { delete element.dataset.motion; entrance.kill(); parallax.forEach((tween) => { tween.scrollTrigger?.kill(); tween.kill(); }); };
    });
  }, [root]);
}

/** The masthead turns solid once the sheet's edge reaches it. Layout positions, not transformed ones: the opening moves as it recedes. */
export function useHeaderState(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const header = root.current;
    if (!header) return;
    const sheet = document.querySelector<HTMLElement>("[data-sheet]");
    const hero = document.querySelector<HTMLElement>("[data-chapter='hero']");
    const edge = () => (sheet ? sheet.offsetTop : (hero?.offsetHeight ?? 600)) - 100;
    const apply = () => { header.dataset.solid = window.scrollY > Math.max(120, edge()) ? "true" : "false"; };
    apply();
    window.addEventListener("scroll", apply, { passive: true });
    window.addEventListener("resize", apply);
    return () => { window.removeEventListener("scroll", apply); window.removeEventListener("resize", apply); };
  }, [root]);
}

/** Words light up one after another as the pinned statement scrolls. */
export function useStatementReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    return withGsap((gsap) => {
      const words = Array.from(element.querySelectorAll<HTMLElement>("[data-word]"));
      if (!words.length) return;
      gsap.set(words, { opacity: 0.16 });
      const tween = gsap.to(words, { opacity: 1, ease: "none", stagger: 0.6, scrollTrigger: { trigger: element, start: "top 55%", end: "bottom 80%", scrub: 0.6 } });
      return () => { tween.scrollTrigger?.kill(); tween.kill(); };
    });
  }, [root]);
}

/** Tween a displayed number towards `value`; the element shows `format(value)` when settled. */
export function useCountUp(ref: RefObject<HTMLElement | null>, value: number, format: (n: number) => string) {
  const shown = useRef(value);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const from = shown.current;
    shown.current = value;
    element.textContent = format(value);
    if (from === value) return;
    return withGsap((gsap) => {
      const counter = { n: from };
      const tween = gsap.to(counter, { n: value, duration: 0.7, ease: "power2.out", onUpdate: () => { element.textContent = format(counter.n); }, onComplete: () => { element.textContent = format(value); } });
      return () => { tween.kill(); element.textContent = format(value); };
    });
  }, [ref, value, format]);
}

/** Count from zero to the number the first time it scrolls into view. */
export function useCountOnView(ref: RefObject<HTMLElement | null>, value: number, format: (n: number) => string) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.textContent = format(value);
    return withGsap((gsap) => {
      const counter = { n: 0 };
      const tween = gsap.to(counter, { n: value, duration: 1.2, ease: "power2.out", onUpdate: () => { element.textContent = format(counter.n); }, onComplete: () => { element.textContent = format(value); }, scrollTrigger: { trigger: element, start: "top 88%", once: true } });
      return () => { tween.scrollTrigger?.kill(); tween.kill(); element.textContent = format(value); };
    });
  }, [ref, value, format]);
}

/** A progress line that fills to `fraction` of its width. */
export function useProgressLine(ref: RefObject<HTMLElement | null>, fraction: number) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.transform = `scaleX(${fraction})`;
    return withGsap((gsap) => {
      const tween = gsap.to(element, { scaleX: fraction, duration: 0.6, ease: "power3.out", overwrite: true });
      return () => { tween.kill(); };
    });
  }, [ref, fraction]);
}

/** The roadmap constellation: cards drift on their orbits, the core breathes. */
export function useOrbitMotion(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    return withGsap((gsap) => {
      const cards = Array.from(element.querySelectorAll<HTMLElement>("[data-orbit-card]"));
      const core = element.querySelector<HTMLElement>("[data-orbit-core]");
      const all = [...cards, ...(core ? [core] : [])];
      // The cards are centred on their anchors with a percentage translate; keep that as
      // GSAP's own xPercent/yPercent so the drift below adds to it instead of replacing it.
      gsap.set(all, { xPercent: -50, yPercent: -50, x: 0, y: 0, opacity: 0, scale: 0.92 });
      const tweens: ReturnType<typeof gsap.to>[] = [];
      const stop = onceVisible([element], () => {
        tweens.push(gsap.to(all, { opacity: 1, scale: 1, duration: 0.8, ease: "power3.out", stagger: 0.07, onComplete: () => {
          cards.forEach((card, index) => tweens.push(gsap.to(card, { y: index % 2 ? 7 : -7, duration: 3.2 + (index % 3) * 0.7, ease: "sine.inOut", yoyo: true, repeat: -1, delay: index * 0.35 })));
          if (core) tweens.push(gsap.to(core, { scale: 1.035, duration: 3.6, ease: "sine.inOut", yoyo: true, repeat: -1 }));
        } }));
      });
      return () => { stop(); tweens.forEach((tween) => tween.kill()); gsap.set(all, { clearProps: "all" }); };
    });
  }, [root]);
}

/**
 * The agents flow: a pulse leaves the agent, passes the link and the prepared
 * change, waits at the approval gate until it lights, then reaches the run.
 * It plays only while the flow is on screen.
 */
export function useFlowMotion(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    return withGsap((gsap) => {
      const pulse = element.querySelector<HTMLElement>("[data-flow-pulse]");
      const gate = element.querySelector<HTMLElement>("[data-flow-gate]");
      const stations = Array.from(element.querySelectorAll<HTMLElement>("[data-flow-station]"));
      if (!pulse || stations.length < 2) return;
      const nodes = stations.map((station) => station.querySelector<HTMLElement>("[data-flow-node]") ?? station);
      const stop = (index: number) => `${((index + 0.5) / stations.length) * 100}%`;
      const timeline = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.4 });
      timeline.set(pulse, { left: stop(0), opacity: 0, scale: 0.5 });
      timeline.to(pulse, { opacity: 1, scale: 1, duration: 0.3 });
      let wait = 0;
      const settle = () => { delete gate?.dataset.approved; stations.forEach((station) => { delete station.dataset.done; }); };
      timeline.call(() => { stations[0].dataset.done = "true"; });
      stations.forEach((station, index) => {
        if (index === 0) return;
        timeline.to(pulse, { left: stop(index), duration: 0.9, ease: "power1.inOut" }, wait ? `+=${wait}` : undefined);
        timeline.to(nodes[index], { scale: 1.07, duration: 0.18, yoyo: true, repeat: 1, ease: "power1.out" });
        timeline.call(() => { station.dataset.done = "true"; });
        wait = 0;
        if (gate && station.contains(gate)) { timeline.call(() => { gate.dataset.approved = "true"; }); wait = 1; }
      });
      timeline.to(pulse, { opacity: 0, scale: 0.5, duration: 0.3 }, wait ? `+=${wait}` : undefined);
      // The finished picture holds for a beat before the loop begins again.
      timeline.call(settle, undefined, "+=1.2");
      let watch = () => {};
      if (typeof IntersectionObserver === "undefined") timeline.play();
      else {
        const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) timeline.play(); else timeline.pause(); }, { threshold: 0.2 });
        observer.observe(element);
        watch = () => observer.disconnect();
      }
      return () => { watch(); timeline.kill(); settle(); gsap.set([pulse, ...nodes], { clearProps: "all" }); };
    });
  }, [root]);
}

/** One leg of the light's journey through the system: a binding id, travelled against the arrow when `reverse`. */
export interface FlowStep { edge: string; reverse?: boolean }

/**
 * A light travels the system's connections in story order and lights each part
 * it reaches, looping while the diagram is on screen. The edges are measured,
 * so the journey is rebuilt whenever `version` (the routed edges) changes.
 */
export function useSystemFlow(root: RefObject<HTMLElement | null>, steps: FlowStep[], version: unknown) {
  useEffect(() => {
    const element = root.current;
    if (!element || !steps.length) return;
    return withGsap((gsap) => {
      const light = element.querySelector<SVGGElement>("[data-flow-light]");
      const legs = steps.flatMap((step) => { const path = element.querySelector<SVGPathElement>(`[data-edge="${step.edge}"]`); return path ? [{ ...step, path }] : []; });
      if (!light || !legs.length) return;
      const lit: HTMLElement[] = [];
      const clear = () => { lit.splice(0).forEach((node) => { delete node.dataset.lit; }); };
      const timeline = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.8, onRepeat: clear });
      timeline.set(light, { opacity: 0, scale: 0.4, transformOrigin: "50% 50%" });
      let at: string | null = null;
      legs.forEach(({ path, reverse }) => {
        const from = reverse ? path.dataset.to : path.dataset.from;
        const to = reverse ? path.dataset.from : path.dataset.to;
        // A new branch starts elsewhere: the light dims, moves while dark, and brightens on the way.
        if (at !== null && at !== from) timeline.to(light, { opacity: 0, scale: 0.4, duration: 0.25 });
        const length = path.getTotalLength();
        timeline.to(light, { motionPath: { path, align: path, alignOrigin: [0.5, 0.5], start: reverse ? 1 : 0, end: reverse ? 0 : 1 }, opacity: 1, scale: 1, duration: Math.min(1.5, Math.max(0.55, length / 240)), ease: "power1.inOut" });
        const arrive = to ? element.querySelector<HTMLElement>(`[data-node="${to}"]`) : null;
        if (arrive) timeline.call(() => { clear(); arrive.dataset.lit = "true"; lit.push(arrive); });
        timeline.to({}, { duration: 0.35 });
        at = to ?? null;
      });
      timeline.to(light, { opacity: 0, scale: 0.4, duration: 0.4 });
      timeline.call(clear);
      const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { if (entry.isIntersecting) timeline.play(); else timeline.pause(); }, { threshold: 0.25 });
      if (observer) observer.observe(element); else timeline.play();
      return () => { observer?.disconnect(); timeline.kill(); clear(); gsap.set(light, { clearProps: "all" }); };
    }, loadMotionPath);
  }, [root, steps, version]);
}

/** The export sheets fan out from a stack the first time they are seen: `--fan` runs 0 → 1 and the stylesheet does the rest. */
export function useFan(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    return withGsap((gsap) => {
      gsap.set(element, { "--fan": 0 });
      let tween: ReturnType<typeof gsap.to> | null = null;
      const stop = onceVisible([element], () => { tween = gsap.to(element, { "--fan": 1, duration: 1.2, ease: "power3.out", delay: 0.2 }); });
      return () => { stop(); tween?.kill(); gsap.set(element, { clearProps: "--fan" }); };
    });
  }, [root]);
}
