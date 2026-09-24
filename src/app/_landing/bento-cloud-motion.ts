"use client";

import { useEffect, type RefObject } from "react";

/** CSS owns the ten-second timeline. Only visibility/preferences cross into JS.
 * Each visible scene shares the same score but pauses independently offscreen.
 * User pause is a separate data attribute, so pause/play never restarts the clock.
 * This hook deliberately does not modify the existing agent animation.
 */
export function useCloudMotion(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element || typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scenes = Array.from(element.querySelectorAll<HTMLElement>("[data-cloud-scene]"));
    const visible = new Set<Element>();
    const sync = () => {
      element.dataset.cloudMotion = motion.matches ? "still" : !document.hidden && visible.size > 0 ? "running" : "paused";
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const shown = entry.isIntersecting && entry.intersectionRatio >= 0.1;
        if (shown) visible.add(entry.target); else visible.delete(entry.target);
        (entry.target as HTMLElement).dataset.sceneVisible = String(shown);
      }
      sync();
    }, { threshold: 0.1 });
    const observe = () => {
      observer.disconnect();
      visible.clear();
      for (const scene of scenes) {
        scene.dataset.sceneVisible = "false";
        if (!motion.matches) observer.observe(scene);
      }
      sync();
    };
    observe();
    motion.addEventListener("change", observe);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", observe);
      document.removeEventListener("visibilitychange", sync);
      element.dataset.cloudMotion = "still";
      scenes.forEach((scene) => { delete scene.dataset.sceneVisible; });
    };
  }, [root]);
}
