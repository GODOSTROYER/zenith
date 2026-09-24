"use client";

import { useEffect, useRef } from "react";

/** A star's place on the turning sky: its angle and distance from the pole (the apex star), in CSS pixels. */
interface Star { angle: number; dist: number; r: number; a: number; phase: number; speed: number; bright: boolean; tint: string }
interface Meteor { x: number; y: number; vx: number; vy: number; born: number; life: number; length: number; width: number }

/** The opening dispatches this on itself when the star at the apex is pressed. */
export const METEORS_EVENT = "zenith:meteors";

/** One full turn of the sky every two and a half minutes: a visible, steady wheel around the apex star. */
const TURN_PER_MS = (Math.PI * 2) / 150_000;
/** Scrolling pushes the sky round: extra turn per scrolled pixel, capped, easing back to the steady turn in about a second. */
const SPIN_PER_PX = 1e-6;
const SPIN_MAX = 6e-4;
const SPIN_EASE_MS = 900;
/** The Milky Way is painted on a square that covers every corner as it turns; its bitmap stays at most this many pixels wide. */
const BACKDROP_MAX = 2048;

/**
 * A sky of stars on a canvas, drawn at the device's own pixel density: a
 * faint band of the Milky Way with thousands of dust-fine points, painted once
 * per resize, and a field of sharper stars over it, dense at the zenith and
 * sparse near the horizon, each twinkling on its own phase; the brightest few
 * carry a soft round halo, tinted warm, pale blue or amber.
 *
 * The whole sky turns slowly around the apex star, as a real sky turns around
 * its pole, and scrolling gives it a push that eases off. Stars and dust live
 * on a disc wide enough to cover the canvas at any angle; the horizon fade
 * follows where a star is on screen, so stars still dim as they swing down.
 * Meteors stay in screen space.
 *
 * On request a wave of meteors crosses the sky. Draws only while visible, at
 * most 30 times a second (60 while meteors fly or the sky is being pushed),
 * and stands still under a reduced-motion preference.
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
    /** The pole (the apex star) in canvas CSS pixels, and the radius that reaches every corner from it. */
    let poleX = 0, poleY = 0, reach = 0;
    /** How far the sky has turned (radians), the extra spin a scroll added (radians per ms), and when the turn was last advanced. */
    let turn = 0, spin = 0, turnedAt = 0;
    const sky = element.closest<HTMLElement>("[data-chapter='hero']") ?? document;

    const gaussian = () => { const u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    /** Mostly warm white, with a few pale blue and amber stars, as the eye sees them. */
    const tint = () => { const t = Math.random(); return t < 0.14 ? "214, 226, 255" : t < 0.26 ? "255, 216, 176" : "255, 244, 232"; };
    /** Denser near the pole, which is the zenith, thinning out towards the rim. */
    const seed = (count: number): Star[] => Array.from({ length: count }, () => {
      const r = 0.35 + Math.pow(Math.random(), 2.2) * 1.5;
      return { angle: Math.random() * Math.PI * 2, dist: reach * Math.pow(Math.random(), 0.75), r, a: 0.3 + Math.random() * 0.7, phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 1.2, bright: r > 1.35, tint: tint() };
    });

    /**
     * The Milky Way: a soft band of haze and dust across the whole disc, a little
     * below the pole, painted once per resize on a square centred on the pole.
     */
    const paintBackdrop = () => {
      const side = reach * 2;
      const scale = Math.min(ratio, BACKDROP_MAX / side);
      backdrop.width = backdrop.height = Math.round(side * scale);
      const back = backdrop.getContext("2d");
      if (!back) return;
      back.setTransform(scale, 0, 0, scale, 0, 0);
      back.clearRect(0, 0, side, side);
      const tilt = 0.46, along = [Math.cos(tilt), Math.sin(tilt)], across = [-Math.sin(tilt), Math.cos(tilt)];
      const centre = [reach + across[0] * reach * 0.18, reach + across[1] * reach * 0.18];
      /** A point on the band: `t` runs 0..1 along it, `off` is CSS pixels to one side. */
      const bandAt = (t: number, off: number) => [centre[0] + along[0] * (t * 2 - 1) * reach + across[0] * off, centre[1] + along[1] * (t * 2 - 1) * reach + across[1] * off];
      back.save();
      back.globalCompositeOperation = "lighter";
      for (let i = 0; i < 20; i++) {
        const [x, y] = bandAt(i / 19, 0);
        const radius = Math.max(width, height) * (0.09 + 0.05 * Math.sin(i * 1.7));
        const glow = back.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, "rgba(255, 220, 200, 0.05)");
        glow.addColorStop(1, "rgba(255, 220, 200, 0)");
        back.fillStyle = glow;
        back.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      back.restore();
      const dust = Math.round(Math.min(5200, (side * height) / 620));
      for (let i = 0; i < dust; i++) {
        const [x, y] = bandAt(Math.random(), gaussian() * 0.07 * height);
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
      if (!preference?.matches) {
        // Capped, so a stalled or hidden tab never comes back to a sky that has jumped.
        const dt = Math.min(time - turnedAt, 100);
        turn += (TURN_PER_MS + spin) * dt;
        spin *= Math.exp(-dt / SPIN_EASE_MS);
      }
      turnedAt = time;
      context.clearRect(0, 0, width, height);
      if (backdrop.width && backdrop.height) {
        context.save();
        context.translate(poleX, poleY);
        context.rotate(-turn);
        context.drawImage(backdrop, -reach, -reach, reach * 2, reach * 2);
        context.restore();
      }
      for (const star of stars) {
        // Counter-clockwise, as the sky turns seen facing its pole.
        const theta = star.angle - turn;
        const x = poleX + Math.cos(theta) * star.dist, y = poleY + Math.sin(theta) * star.dist;
        const extent = star.bright ? star.r * 8 : star.r;
        if (x < -extent || x > width + extent || y < -extent || y > height + extent) continue;
        const twinkle = preference?.matches ? 1 : 0.65 + 0.35 * Math.sin(time * 0.001 * star.speed + star.phase);
        const alpha = star.a * twinkle * Math.max(0, 1 - (y / height) * 0.75);
        if (star.bright) {
          // A layered round halo, no spikes: a wide faint bloom under a tighter glow.
          for (const [reachOf, strength] of [[8, 0.16], [3.2, 0.5]] as const) {
            const glow = context.createRadialGradient(x, y, 0, x, y, star.r * reachOf);
            glow.addColorStop(0, `rgba(${star.tint}, ${(alpha * strength).toFixed(3)})`);
            glow.addColorStop(1, `rgba(${star.tint}, 0)`);
            context.fillStyle = glow;
            context.fillRect(x - star.r * reachOf, y - star.r * reachOf, star.r * reachOf * 2, star.r * reachOf * 2);
          }
        }
        context.beginPath();
        context.arc(x, y, star.r, 0, Math.PI * 2);
        context.fillStyle = `rgba(${star.tint}, ${alpha.toFixed(3)})`;
        context.fill();
      }
      if (meteors.length) drawMeteors(time);
    };
    const loop = (time: number) => {
      frame = null;
      if (!visible || document.visibilityState === "hidden" || preference?.matches) return;
      if (time - last >= (meteors.length || Math.abs(spin) > 1e-5 ? 1000 / 60 : 1000 / 30)) { last = time; draw(time); }
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
      // The pole is the apex star, wherever the layout put it; the classic opening has none, so top centre.
      const apex = sky.querySelector<HTMLElement>("[data-hero-apex]")?.getBoundingClientRect();
      poleX = apex ? apex.left + apex.width / 2 - rect.left : width / 2;
      poleY = apex ? apex.top + apex.height / 2 - rect.top : height * 0.12;
      reach = Math.max(Math.hypot(poleX, poleY), Math.hypot(width - poleX, poleY), Math.hypot(poleX, height - poleY), Math.hypot(width - poleX, height - poleY)) + 8;
      // As many on screen as before: the disc is bigger than the canvas, so it holds more.
      stars = seed(Math.round(Math.min(1800, (Math.PI * reach * reach) / 2300)));
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
    sky.addEventListener(METEORS_EVENT, wave);
    /** Scrolling down pushes the sky forward, scrolling up pushes it back. */
    let scrolledTo = window.scrollY;
    const push = () => {
      const delta = window.scrollY - scrolledTo;
      scrolledTo = window.scrollY;
      if (preference?.matches) return;
      spin = Math.max(-SPIN_MAX, Math.min(SPIN_MAX, spin + delta * SPIN_PER_PX));
      start();
    };
    window.addEventListener("scroll", push, { passive: true });
    resize();
    scheduleAmbient();
    return () => { stop(); if (ambient) clearTimeout(ambient); observer?.disconnect(); sizer?.disconnect(); document.removeEventListener("visibilitychange", visibility); preference?.removeEventListener("change", motion); sky.removeEventListener(METEORS_EVENT, wave); window.removeEventListener("scroll", push); };
  }, []);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
