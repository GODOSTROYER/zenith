"use client";
/**
 * The Map Assembles — the landing hero's single authored motion moment.
 *
 * A canvas-2D orchestration of the demo "atlas" system going from nothing to
 * Live: nodes arrive, bindings wire themselves, the plan prices, a deploy
 * pulse walks the edges, health turns green, the URL lands. Loops gently.
 *
 * Honesty: everything drawn is the product's real vocabulary and the real
 * demo system; the caption stream labels it simulated.
 *
 * prefers-reduced-motion: renders the final assembled frame, no loop.
 * Pauses off-screen and when the tab is hidden. Theme-aware via CSS vars.
 */
import { useEffect, useRef } from "react";

export type HeroPhase =
  | "assemble"
  | "wire"
  | "price"
  | "deploy"
  | "live"
  | "still";

interface Props {
  onPhase?: (phase: HeroPhase) => void;
  /** anchor the scene to the right (desktop) or center (stacked mobile) */
  align?: "right" | "center";
  className?: string;
}

/* ------------------------------- scene data ------------------------------- */

type Kind = "route" | "service" | "resource";

interface NodeSpec {
  id: string;
  kind: Kind;
  label: string;
  sub: string;
  cost?: string;
  x: number; // scene coords, 0..1000
  y: number; // scene coords, 0..640
  w: number;
  h: number;
  glyph: "globe" | "grid" | "gear" | "db" | "bolt" | "list" | "mail";
}

const NODES: NodeSpec[] = [
  { id: "route", kind: "route", label: "app.atlas.orrery.app", sub: "", x: 60, y: 280, w: 252, h: 46, glyph: "globe" },
  { id: "web", kind: "service", label: "web", sub: "web · standard × 2", cost: "$28.00/mo", x: 400, y: 176, w: 196, h: 68, glyph: "grid" },
  { id: "worker", kind: "service", label: "worker", sub: "worker · small × 2", cost: "$14.00/mo", x: 400, y: 396, w: 196, h: 68, glyph: "gear" },
  { id: "postgres", kind: "resource", label: "postgres", sub: "postgres · standard", cost: "$26.00/mo", x: 748, y: 84, w: 184, h: 60, glyph: "db" },
  { id: "cache", kind: "resource", label: "cache", sub: "redis · small", cost: "$8.00/mo", x: 748, y: 232, w: 184, h: 60, glyph: "bolt" },
  { id: "jobs", kind: "resource", label: "jobs", sub: "queue · small", cost: "$2.00/mo", x: 748, y: 380, w: 184, h: 60, glyph: "list" },
  { id: "mail", kind: "resource", label: "mail", sub: "email · small", cost: "$3.00/mo", x: 748, y: 528, w: 184, h: 60, glyph: "mail" },
];

interface EdgeSpec {
  from: string;
  to: string;
  label: string;
}

const EDGES: EdgeSpec[] = [
  { from: "route", to: "web", label: "https" },
  { from: "web", to: "postgres", label: "sql" },
  { from: "web", to: "cache", label: "cache" },
  { from: "web", to: "jobs", label: "publish" },
  { from: "worker", to: "jobs", label: "consume" },
  { from: "worker", to: "postgres", label: "sql" },
  { from: "worker", to: "mail", label: "smtp" },
];

const SCENE_W = 1000;
const SCENE_H = 640;

/* ------------------------------- timeline --------------------------------- */

const T = {
  nodeStart: 300,
  nodeEvery: 330,
  wireStart: 3000,
  wireEvery: 340,
  priceStart: 5700,
  priceEvery: 240,
  planPill: 7000,
  deployStart: 8200,
  deployEvery: 300,
  healthStart: 9400,
  healthEvery: 260,
  live: 11400,
  hold: 15200,
  fade: 15900,
  loop: 16600,
} as const;

function phaseAt(t: number): HeroPhase {
  if (t < T.wireStart) return "assemble";
  if (t < T.priceStart) return "wire";
  if (t < T.deployStart) return "price";
  if (t < T.live) return "deploy";
  return "live";
}

/* --------------------------------- helpers -------------------------------- */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);

interface Palette {
  ink: string;
  mute: string;
  faint: string;
  card: string;
  cardTop: string;
  line: string;
  signal: string;
  ok: string;
  warn: string;
  onSignal: string;
  grid: string;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", "#e9edf5"),
    mute: v("--ink-mute", "#9aa5bd"),
    faint: v("--ink-faint", "#667089"),
    card: v("--bg2", "#141a26"),
    cardTop: v("--bg3", "#1a2132"),
    line: v("--line-strong", "rgba(151,165,199,.28)"),
    signal: v("--signal", "#53e0be"),
    ok: v("--ok", "#45d59b"),
    warn: v("--warn", "#e5b055"),
    onSignal: v("--on-signal", "#04241c"),
    grid: v("--line", "rgba(151,165,199,.14)"),
  };
}

function resolveFonts(): { sans: string; mono: string } {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden";
  document.body.appendChild(probe);
  const sans = getComputedStyle(document.body).fontFamily || "sans-serif";
  probe.className = "font-mono";
  const mono = getComputedStyle(probe).fontFamily || "monospace";
  probe.remove();
  return { sans, mono };
}

/* --------------------------------- drawing -------------------------------- */

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: NodeSpec["glyph"],
  x: number,
  y: number,
  color: string
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const r = 6.5;
  switch (glyph) {
    case "globe":
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.moveTo(0, -r);
      ctx.bezierCurveTo(3.6, -r * 0.55, 3.6, r * 0.55, 0, r);
      ctx.bezierCurveTo(-3.6, r * 0.55, -3.6, -r * 0.55, 0, -r);
      ctx.stroke();
      break;
    case "grid":
      for (const [gx, gy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        ctx.strokeRect(gx * 3.6 - 2.6, gy * 3.6 - 2.6, 5.2, 5.2);
      }
      break;
    case "gear":
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 4.6, Math.sin(a) * 4.6);
        ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7);
        ctx.stroke();
      }
      break;
    case "db":
      ctx.beginPath();
      ctx.ellipse(0, -4, 6.4, 2.6, 0, 0, Math.PI * 2);
      ctx.moveTo(-6.4, -4);
      ctx.lineTo(-6.4, 4);
      ctx.ellipse(0, 4, 6.4, 2.6, 0, Math.PI, 0, true);
      ctx.moveTo(6.4, -4);
      ctx.lineTo(6.4, 4);
      ctx.stroke();
      break;
    case "bolt":
      ctx.beginPath();
      ctx.moveTo(1.6, -7);
      ctx.lineTo(-3.4, 1);
      ctx.lineTo(0.2, 1);
      ctx.lineTo(-1.6, 7);
      ctx.lineTo(3.4, -1);
      ctx.lineTo(-0.2, -1);
      ctx.closePath();
      ctx.stroke();
      break;
    case "list":
      for (const gy of [-4.4, 0, 4.4]) {
        ctx.beginPath();
        ctx.moveTo(-6, gy);
        ctx.lineTo(-4.4, gy);
        ctx.moveTo(-1.6, gy);
        ctx.lineTo(6.4, gy);
        ctx.stroke();
      }
      break;
    case "mail":
      ctx.strokeRect(-6.4, -4.4, 12.8, 8.8);
      ctx.beginPath();
      ctx.moveTo(-6.4, -4.4);
      ctx.lineTo(0, 1);
      ctx.lineTo(6.4, -4.4);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function edgePath(from: NodeSpec, to: NodeSpec): [number, number, number, number, number, number, number, number] {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const dx = Math.max(50, (x2 - x1) * 0.45);
  return [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2];
}

function pointOnCubic(
  p: [number, number, number, number, number, number, number, number],
  t: number
): [number, number] {
  const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = p;
  const u = 1 - t;
  const x = u * u * u * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x2;
  const y = u * u * u * y1 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y2;
  return [x, y];
}

/* -------------------------------- component -------------------------------- */

export function HeroCanvas({ onPhase, align = "right", className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef<HeroPhase | null>(null);
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let palette = readPalette();
    let fonts = { sans: "sans-serif", mono: "monospace" };
    try {
      fonts = resolveFonts();
    } catch {
      /* keep fallbacks */
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let start = performance.now();
    let visible = true;
    let running = true;
    let cssW = 0;
    let cssH = 0;
    let scale = 1;
    let offX = 0;
    let offY = 0;

    const nodeById = new Map(NODES.map((n) => [n.id, n]));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Right-aligned scenes live in the right ~45% of the hero and never
      // start left of 55% of the viewport, so the headline column (centered
      // 1180px container, 620px text block) is never overlapped.
      const availW = align === "right" ? cssW * 0.44 : cssW;
      scale = Math.min(availW / SCENE_W, cssH / SCENE_H);
      offY = (cssH - SCENE_H * scale) / 2;
      offX =
        align === "right"
          ? Math.max(cssW * 0.55, cssW - SCENE_W * scale - 56)
          : (cssW - SCENE_W * scale) / 2;
    };

    const setPhase = (p: HeroPhase) => {
      if (phaseRef.current !== p) {
        phaseRef.current = p;
        onPhaseRef.current?.(p);
      }
    };

    const draw = (now: number) => {
      const t = reduced ? T.hold - 1 : (now - start) % T.loop;
      if (!reduced && now - start >= T.loop) start = now - (t % T.loop);

      const globalAlpha = t > T.fade ? 1 - (t - T.fade) / (T.loop - T.fade) : 1;
      setPhase(reduced ? "still" : phaseAt(t));

      ctx.clearRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.globalAlpha = globalAlpha;
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);

      /* the product's own canvas dot grid */
      ctx.fillStyle = palette.grid;
      for (let gx = 20; gx < SCENE_W; gx += 44) {
        for (let gy = 20; gy < SCENE_H; gy += 44) {
          ctx.fillRect(gx, gy, 1.6, 1.6);
        }
      }

      /* edges */
      EDGES.forEach((e, i) => {
        const p = clamp01((t - (T.wireStart + i * T.wireEvery)) / 700);
        if (p <= 0) return;
        const from = nodeById.get(e.from)!;
        const to = nodeById.get(e.to)!;
        const path = edgePath(from, to);
        ctx.save();
        ctx.strokeStyle = palette.line;
        ctx.lineWidth = 1.4;
        if (p < 1) {
          // reveal by drawing partial curve as polyline samples
          ctx.beginPath();
          const steps = Math.max(2, Math.floor(40 * p));
          for (let s = 0; s <= steps; s++) {
            const [px, py] = pointOnCubic(path, (s / steps) * easeOut(p));
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(path[0], path[1]);
          ctx.bezierCurveTo(path[2], path[3], path[4], path[5], path[6], path[7]);
          ctx.stroke();
          // capability label at midpoint
          const [mx, my] = pointOnCubic(path, 0.5);
          ctx.font = `10.5px ${fonts.mono}`;
          const tw = ctx.measureText(e.label).width;
          ctx.fillStyle = palette.card;
          roundRect(ctx, mx - tw / 2 - 6, my - 9, tw + 12, 17, 8);
          ctx.fill();
          ctx.strokeStyle = palette.grid;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = palette.faint;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(e.label, mx, my + 0.5);
          ctx.textAlign = "left";
        }
        ctx.restore();

        /* deploy pulse riding the finished edge */
        const dp = (t - (T.deployStart + i * T.deployEvery)) / 900;
        if (dp > 0 && dp < 1 && !reduced) {
          const [px, py] = pointOnCubic(path, easeOut(dp));
          ctx.save();
          ctx.fillStyle = palette.signal;
          ctx.shadowColor = palette.signal;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(px, py, 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      /* nodes */
      NODES.forEach((n, i) => {
        const p = clamp01((t - (T.nodeStart + i * T.nodeEvery)) / 600);
        if (p <= 0) return;
        const e = easeOut(p);
        const dy = (1 - e) * 16;
        const alpha = e;

        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.translate(0, dy);

        const isRoute = n.kind === "route";
        const r = isRoute ? n.h / 2 : 12;

        ctx.fillStyle = palette.card;
        roundRect(ctx, n.x, n.y, n.w, n.h, r);
        ctx.fill();
        ctx.strokeStyle = palette.line;
        ctx.lineWidth = 1;
        ctx.stroke();

        drawGlyph(
          ctx,
          n.glyph,
          n.x + (isRoute ? 24 : 26),
          n.y + n.h / 2 - (isRoute ? 0 : n.sub ? 0 : 0),
          n.kind === "route" ? palette.mute : palette.signal
        );

        ctx.textBaseline = "middle";
        if (isRoute) {
          ctx.font = `600 14px ${fonts.mono}`;
          ctx.fillStyle = palette.ink;
          ctx.fillText(n.label, n.x + 42, n.y + n.h / 2 + 0.5);
          /* TLS lock appears when live */
          const lockP = clamp01((t - T.live) / 400);
          if (lockP > 0) {
            ctx.save();
            ctx.globalAlpha *= lockP;
            const lx = n.x + n.w - 24;
            const ly = n.y + n.h / 2;
            ctx.strokeStyle = palette.ok;
            ctx.lineWidth = 1.4;
            ctx.strokeRect(lx - 4.6, ly - 1.4, 9.2, 7);
            ctx.beginPath();
            ctx.arc(lx, ly - 2.4, 3.2, Math.PI, 0);
            ctx.stroke();
            ctx.restore();
          }
        } else {
          ctx.font = `600 15px ${fonts.sans}`;
          ctx.fillStyle = palette.ink;
          ctx.fillText(n.label, n.x + 44, n.y + 22);
          // Sub label yields space to the right-aligned cost — never collide.
          ctx.font = `11px ${fonts.mono}`;
          const costW = n.cost ? ctx.measureText(n.cost).width + 10 : 0;
          ctx.font = `11.5px ${fonts.sans}`;
          ctx.fillStyle = palette.mute;
          const maxSubW = n.w - 44 - 14 - costW;
          let sub = n.sub;
          if (ctx.measureText(sub).width > maxSubW) {
            while (sub.length > 1 && ctx.measureText(`${sub}…`).width > maxSubW) {
              sub = sub.slice(0, -1);
            }
            sub = `${sub.trimEnd()}…`;
          }
          ctx.fillText(sub, n.x + 44, n.y + n.h - 20);

          /* cost, arriving in the pricing beat */
          if (n.cost) {
            const cp = clamp01(
              (t - (T.priceStart + i * T.priceEvery)) / 420
            );
            if (cp > 0) {
              ctx.save();
              ctx.globalAlpha *= easeOut(cp);
              ctx.font = `11px ${fonts.mono}`;
              ctx.fillStyle = palette.faint;
              ctx.textAlign = "right";
              ctx.fillText(n.cost, n.x + n.w - 14, n.y + n.h - 20);
              ctx.restore();
            }
          }

          /* health dot: warm while deploying, green when verified */
          const hp = t - (T.healthStart + i * T.healthEvery);
          const dotX = n.x + n.w - 14;
          const dotY = n.y + 14;
          if (t > T.deployStart) {
            const green = hp > 0;
            const breathe = reduced ? 1 : 0.75 + 0.25 * Math.sin(now / 700 + i);
            ctx.save();
            ctx.globalAlpha *= green ? 1 : 0.9;
            ctx.fillStyle = green ? palette.ok : palette.warn;
            ctx.beginPath();
            ctx.arc(dotX, dotY, green ? 3.4 : 3.4 * breathe, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.restore();
      });

      /* plan pill */
      const planP = clamp01((t - T.planPill) / 500);
      if (planP > 0) {
        const done = clamp01((t - T.deployStart) / 400);
        ctx.save();
        ctx.globalAlpha *= easeOut(planP) * (1 - done * 0.4);
        const label = "7 creates · est $81.50/mo · low risk";
        ctx.font = `12px ${fonts.mono}`;
        const tw = ctx.measureText(label).width;
        const px = 400;
        const py = 18;
        ctx.fillStyle = palette.cardTop;
        roundRect(ctx, px, py, tw + 28, 30, 15);
        ctx.fill();
        ctx.strokeStyle = palette.line;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = palette.mute;
        ctx.textBaseline = "middle";
        ctx.fillText(label, px + 14, py + 16);
        ctx.restore();
      }

      /* the Live chip */
      const liveP = clamp01((t - T.live) / 500);
      if (liveP > 0) {
        const e = easeOut(liveP);
        ctx.save();
        ctx.globalAlpha *= e;
        const label = "Live · https://app.atlas.orrery.app";
        ctx.font = `600 12.5px ${fonts.mono}`;
        const tw = ctx.measureText(label).width;
        const px = 58;
        const py = 356;
        ctx.fillStyle = palette.signal;
        roundRect(ctx, px, py, tw + 30, 32, 16);
        ctx.fill();
        ctx.fillStyle = palette.onSignal;
        ctx.textBaseline = "middle";
        ctx.fillText(label, px + 15, py + 17);
        /* one expanding ring, once */
        if (liveP < 1 && !reduced) {
          ctx.strokeStyle = palette.signal;
          ctx.globalAlpha = (1 - liveP) * 0.5;
          ctx.lineWidth = 1.5;
          roundRect(
            ctx,
            px - 10 * e,
            py - 10 * e,
            tw + 30 + 20 * e,
            32 + 20 * e,
            26
          );
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.restore();
    };

    const frame = (now: number) => {
      // Self-heal stale geometry: fonts/layout settling after first paint can
      // change the element's size without a resize event we caught in time.
      if (canvas.clientWidth && Math.abs(canvas.clientWidth - cssW) > 1) resize();
      if (running && visible) draw(now);
      raf = requestAnimationFrame(frame);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.05 }
    );
    io.observe(canvas);

    const onVis = () => {
      running = !document.hidden;
      if (running) start = performance.now() - (reduced ? 0 : 0);
    };
    document.addEventListener("visibilitychange", onVis);

    const mo = new MutationObserver(() => {
      palette = readPalette();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    if (reduced) {
      // Single static frame of the assembled, live system.
      resize();
      draw(performance.now());
      setPhase("still");
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [align]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label="The Orrery system map assembling itself: services and resources appear, bindings wire them together, the plan is priced, a deploy runs, and the system goes live at app.atlas.orrery.app. Simulated demonstration."
    />
  );
}
