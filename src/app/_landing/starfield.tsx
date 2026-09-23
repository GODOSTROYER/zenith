"use client";

import { useEffect, useRef } from "react";

interface Star { x: number; y: number; r: number; a: number; phase: number; speed: number; bright: boolean }
interface Meteor { x: number; y: number; vx: number; vy: number; born: number; life: number; length: number; width: number }

/** The opening dispatches this on itself when the star at the apex is pressed. */
export const METEORS_EVENT = "zenith:meteors";

/**
 * A sky of stars on a canvas, drawn at the device's own pixel density: a
 * faint band of the Milky Way with thousands of dust-fine points, painted once
 * per resize, and a field of sharper stars over it, dense at the zenith and
 * sparse near the horizon, each twinkling on its own phase; the brightest few
 * carry a soft glint. On request a wave of meteors crosses the sky. Draws only
 * while visible, at most 30 times a second (60 while meteors fly), and stands
 * still under a reduced-motion preference.
 */
export function Starfield({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d");
    if (!context) return;
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const backdrop = document.createElement("canvas");
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let width = 0, height = 0, ratio = 1, frame: number | null = null, last = 0, visible = true;

    const gaussian = () => { const u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const seed = (count: number): Star[] => Array.from({ length: count }, () => {
      const y = Math.pow(Math.random(), 1.6);
      const r = 0.35 + Math.pow(Math.random(), 2.2) * 1.5;
      return { x: Math.random(), y, r, a: 0.3 + Math.random() * 0.7, phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 1.2, bright: r > 1.35 };
    });

    /** The Milky Way: a soft diagonal band of haze and dust, painted once. */
    const paintBackdrop = () => {
      backdrop.width = Math.round(width * ratio); backdrop.height = Math.round(height * ratio);
      const back = backdrop.getContext("2d");
      if (!back) return;
      back.setTransform(ratio, 0, 0, ratio, 0, 0);
      back.clearRect(0, 0, width, height);
      const bandAt = (t: number) => 0.12 + 0.5 * t;
      back.save();
      back.globalCompositeOperation = "lighter";
      for (let i = 0; i < 14; i++) {
        const t = i / 13, x = t * width, y = bandAt(t) * height;
        const radius = Math.max(width, height) * (0.09 + 0.05 * Math.sin(i * 1.7));
        const glow = back.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, "rgba(255, 220, 200, 0.05)");
        glow.addColorStop(1, "rgba(255, 220, 200, 0)");
        back.fillStyle = glow;
        back.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      back.restore();
      const dust = Math.round(Math.min(2600, (width * height) / 620));
      for (let i = 0; i < dust; i++) {
        const t = Math.random();
        const x = t * width, y = (bandAt(t) + gaussian() * 0.07) * height;
        if (y < 0 || y > height * 0.78) continue;
        const r = 0.25 + Math.random() * 0.55;
        back.beginPath();
        back.arc(x, y, r, 0, Math.PI * 2);
        back.fillStyle = `rgba(245, 240, 235, ${(0.08 + Math.random() * 0.3).toFixed(3)})`;
        back.fill();
      }
    };

    /** A wave of meteors, a dozen or so unless told otherwise, staggered over a second and a half, falling down and to the left. */
    const spawn = (count: number) => {
      if (preference?.matches || !width) return;
      const now = performance.now();
      for (let i = 0; i < count; i++) {
        const speed = 720 + Math.random() * 520;
        const angle = Math.PI * (0.63 + Math.random() * 0.09);
        meteors.push({
          x: (0.2 + Math.random() * 0.9) * width, y: -(0.04 + Math.random() * 0.24) * height,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          born: now + i * (90 + Math.random() * 150), life: 900 + Math.random() * 700,
          length: 110 + Math.random() * 170, width: 0.9 + Math.random() * 1.3,
        });
      }
      start();
    };
    const wave = (event?: Event) => spawn((event as CustomEvent<{ count?: number }> | undefined)?.detail?.count ?? 9 + Math.floor(Math.random() * 5));
    /* Left alone, the sky sends one meteor now and then, and once in a while a few together. */
    let ambient: ReturnType<typeof setTimeout> | null = null;
    const scheduleAmbient = () => {
      if (ambient) clearTimeout(ambient);
      ambient = setTimeout(() => {
        ambient = null;
        if (visible && document.visibilityState === "visible" && !preference?.matches) spawn(Math.random() < 0.72 ? 1 : 2 + Math.floor(Math.random() * 3));
        scheduleAmbient();
      }, 9000 + Math.random() * 16000);
    };

    const drawMeteors = (time: number) => {
      meteors = meteors.filter((meteor) => time - meteor.born < meteor.life);
      context.save();
      context.lineCap = "round";
      for (const meteor of meteors) {
        const age = time - meteor.born;
        if (age < 0) continue;
        const t = age / meteor.life;
        const alpha = Math.sin(Math.PI * t) * 0.95;
        const seconds = age / 1000;
        const hx = meteor.x + meteor.vx * seconds, hy = meteor.y + meteor.vy * seconds;
        const norm = Math.hypot(meteor.vx, meteor.vy);
        const tx = hx - (meteor.vx / norm) * meteor.length, ty = hy - (meteor.vy / norm) * meteor.length;
        const tail = context.createLinearGradient(hx, hy, tx, ty);
        tail.addColorStop(0, `rgba(255, 246, 236, ${alpha.toFixed(3)})`);
        tail.addColorStop(0.35, `rgba(255, 214, 190, ${(alpha * 0.5).toFixed(3)})`);
        tail.addColorStop(1, "rgba(255, 214, 190, 0)");
        context.strokeStyle = tail;
        context.lineWidth = meteor.width;
        context.beginPath();
        context.moveTo(hx, hy);
        context.lineTo(tx, ty);
        context.stroke();
        const head = context.createRadialGradient(hx, hy, 0, hx, hy, 6);
        head.addColorStop(0, `rgba(255, 255, 250, ${alpha.toFixed(3)})`);
        head.addColorStop(1, "rgba(255, 255, 250, 0)");
        context.fillStyle = head;
        context.fillRect(hx - 6, hy - 6, 12, 12);
      }
      context.restore();
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      if (backdrop.width && backdrop.height) context.drawImage(backdrop, 0, 0, width, height);
      for (const star of stars) {
        const twinkle = preference?.matches ? 1 : 0.65 + 0.35 * Math.sin(time * 0.001 * star.speed + star.phase);
        const alpha = star.a * twinkle * (1 - star.y * 0.75);
        const x = star.x * width, y = star.y * height;
        if (star.bright) {
          const glow = context.createRadialGradient(x, y, 0, x, y, star.r * 5);
          glow.addColorStop(0, `rgba(255, 240, 225, ${(alpha * 0.45).toFixed(3)})`);
          glow.addColorStop(1, "rgba(255, 240, 225, 0)");
          context.fillStyle = glow;
          context.fillRect(x - star.r * 5, y - star.r * 5, star.r * 10, star.r * 10);
          context.strokeStyle = `rgba(255, 246, 236, ${(alpha * 0.5).toFixed(3)})`;
          context.lineWidth = 0.6;
          context.beginPath();
          context.moveTo(x - star.r * 4.5, y); context.lineTo(x + star.r * 4.5, y);
          context.moveTo(x, y - star.r * 4.5); context.lineTo(x, y + star.r * 4.5);
          context.stroke();
        }
        context.beginPath();
        context.arc(x, y, star.r, 0, Math.PI * 2);
        context.fillStyle = `rgba(255, 246, 236, ${alpha.toFixed(3)})`;
        context.fill();
      }
      if (meteors.length) drawMeteors(time);
    };
    const loop = (time: number) => {
      frame = null;
      if (!visible || document.visibilityState === "hidden" || preference?.matches) return;
      if (time - last >= (meteors.length ? 1000 / 60 : 1000 / 30)) { last = time; draw(time); }
      frame = requestAnimationFrame(loop);
    };
    const start = () => { if (frame === null && visible && !preference?.matches) frame = requestAnimationFrame(loop); };
    const stop = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
    const resize = () => {
      const rect = element.getBoundingClientRect();
      ratio = Math.min(window.devicePixelRatio || 1, 3);
      width = rect.width; height = rect.height;
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      stars = seed(Math.round(Math.min(720, (width * height) / 2300)));
      paintBackdrop();
      draw(performance.now());
      start();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) start(); else stop(); });
    observer?.observe(element);
    const visibility = () => { if (document.visibilityState === "hidden") stop(); else start(); };
    document.addEventListener("visibilitychange", visibility);
    const motion = () => { stop(); meteors = []; draw(performance.now()); start(); };
    preference?.addEventListener("change", motion);
    const sizer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    sizer?.observe(element);
    const sky = element.closest<HTMLElement>("[data-chapter='hero']") ?? document;
    sky.addEventListener(METEORS_EVENT, wave);
    resize();
    scheduleAmbient();
    return () => { stop(); if (ambient) clearTimeout(ambient); observer?.disconnect(); sizer?.disconnect(); document.removeEventListener("visibilitychange", visibility); preference?.removeEventListener("change", motion); sky.removeEventListener(METEORS_EVENT, wave); };
  }, []);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
