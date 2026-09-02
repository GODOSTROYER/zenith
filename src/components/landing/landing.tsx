"use client";
/**
 * Orrery landing — "The Map Assembles".
 * One authored motion moment (the hero canvas); everything after it is
 * composed, quiet, and true. All demo material is the real "atlas" system
 * and is labeled simulated. No invented commercial claims anywhere.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Check,
  Copy,
  Pause,
  Play,
} from "lucide-react";
import { cx } from "@/lib/format";
import { ThemeToggle } from "@/components/ui";
import { HeroCanvas, type HeroPhase } from "./hero-canvas";

export interface ProviderRow {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
}

/* --------------------------------- helpers -------------------------------- */

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    // A block taller than the viewport can never reach a ratio of 0.18, so the
    // observer would never fire for it — those watch for first contact instead.
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.7;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: tall ? 0 : 0.18 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, shown };
}

function Reveal({
  children,
  className,
  delay = 0,
  rise = false,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  /**
   * The page's entrance motion belongs to the two display headlines only —
   * the hero canvas is the authored moment. Everything else renders static.
   */
  rise?: boolean;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  if (!rise) return <div className={className}>{children}</div>;
  return (
    <div
      ref={ref}
      className={cx("transition-all duration-[560ms] [transition-timing-function:var(--ease-swift)]", className)}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(14px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  // The clipboard API is missing on non-secure origins and can be refused by
  // permission policy, so the failure is shown rather than swallowed.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2400);
  };
  return (
    <>
      <button
        type="button"
        onClick={copy}
        title={
          state === "failed"
            ? "Copy blocked by the browser — select the text and press ⌘/Ctrl+C."
            : `Copy ${label}`
        }
        className={cx(
          "inline-flex items-center gap-2 rounded-[8px] border bg-bg2 px-3 py-1.5",
          "font-mono text-[12.5px] transition-colors duration-[120ms]",
          state === "failed"
            ? "border-err/50 text-err"
            : "border-line text-ink-mute hover:border-line-strong hover:text-ink"
        )}
        aria-label={`Copy ${label}`}
      >
        {state === "done" ? (
          <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
        ) : state === "failed" ? (
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
        {text}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === "done" ? "Copied" : state === "failed" ? "Copy blocked by the browser" : ""}
      </span>
    </>
  );
}

/* ---------------------------------- copy ----------------------------------- */

const PHASE_CAPTION: Record<HeroPhase, string> = {
  assemble: "assembling the system — services, resources, a route",
  wire: "wiring bindings — credentials injected, never hardcoded",
  price: "pricing the plan — every change carries its cost",
  deploy: "deploying to staging — each step streamed, each step honest",
  live: "live at app.atlas.orrery.app — the URL is the finish line",
  still: "the demo system, assembled and live — simulated",
};

/* --------------------------------- sections -------------------------------- */

function Header({ cta }: { cta: { href: string; label: string } }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header
      className={cx(
        "fixed inset-x-0 top-0 z-40 transition-colors duration-[200ms]",
        scrolled ? "border-b border-line bg-bg0/95" : "border-b border-transparent"
      )}
    >
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between px-6">
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="relative inline-block h-[18px] w-[18px] rounded-full border-[1.5px] border-signal">
            <span className="absolute -top-[3px] left-[9px] h-[6px] w-[6px] rounded-full bg-signal" />
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Orrery</span>
        </span>
        <nav className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href={cta.href}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-[8px] bg-signal px-3.5 py-1.5",
              "text-[13px] font-semibold text-on-signal transition-transform duration-[120ms] hover:scale-[1.03]"
            )}
          >
            {cta.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero({ cta }: { cta: { href: string; label: string } }) {
  const [phase, setPhase] = useState<HeroPhase>("assemble");
  const onPhase = useCallback((p: HeroPhase) => setPhase(p), []);
  return (
    <section className="relative flex min-h-[100svh] flex-col overflow-hidden">
      {/* canvas behind on desktop, below on small screens */}
      <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden="false">
        <HeroCanvas onPhase={onPhase} align="right" className="h-full w-full" />
      </div>
      <div className="relative mx-auto flex w-full max-w-[1180px] flex-1 flex-col justify-center px-6 pt-24 lg:pt-14">
        <div className="max-w-[620px]">
          <h1 className="animate-enter text-balance text-[clamp(42px,7vw,84px)] font-bold leading-[0.98] tracking-[-0.025em] text-ink">
            Your infrastructure, in&nbsp;motion.
          </h1>
          <p
            className="mt-6 max-w-[52ch] text-[16.5px] leading-[1.65] text-ink-mute animate-enter"
            style={{ animationDelay: "120ms" }}
          >
            Orrery is a deployment platform for small teams that shows the whole
            system — services, data, and the wiring between them — prices every
            change before it applies, and ends every deploy with a URL you can
            open.
          </p>
          <div
            className="mt-9 flex flex-wrap items-center gap-3 animate-enter"
            style={{ animationDelay: "220ms" }}
          >
            <Link
              href={cta.href}
              className={cx(
                "inline-flex items-center gap-2 rounded-[10px] bg-signal px-6 py-3 text-[15px] font-semibold text-on-signal",
                "transition-transform duration-[120ms] hover:scale-[1.02] active:scale-[0.99]"
              )}
            >
              {cta.label}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <a
              href="#one-model"
              className={cx(
                "inline-flex items-center gap-2 rounded-[10px] border border-line px-5 py-3 text-[14px] text-ink-mute",
                "transition-colors duration-[120ms] hover:border-line-strong hover:text-ink"
              )}
            >
              How it works
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
          {/* Narration synced to the canvas. Not a live region: it changes six
              times per loop, forever — the canvas aria-label carries the story
              for screen readers instead. */}
          <p
            className="mt-10 flex items-center gap-2.5 font-mono text-[12.5px] text-ink-faint animate-enter"
            style={{ animationDelay: "320ms" }}
          >
            <span
              aria-hidden
              className={cx(
                "inline-block h-[7px] w-[7px] rounded-full",
                phase === "live" || phase === "still" ? "bg-ok" : "bg-signal",
                phase !== "still" && "status-pulse"
              )}
            />
            {PHASE_CAPTION[phase]}
            <span className="rounded-[4px] border border-line px-1.5 py-px text-[10.5px] uppercase tracking-[0.08em]">
              simulated
            </span>
          </p>
        </div>
      </div>
      <div className="relative mx-auto -mt-2 h-[340px] w-full max-w-[720px] px-4 lg:hidden">
        {/* The visible canvas owns the narration below lg; the hidden desktop
            canvas pauses off-screen and stops phoning phases in. */}
        <HeroCanvas onPhase={onPhase} align="center" className="h-full w-full" />
      </div>
    </section>
  );
}

/* one fact, four surfaces */
const SURFACES = ["System Map", "Source", "API", "Navigator"] as const;
type Surface = (typeof SURFACES)[number];

const slug = (s: Surface) => s.toLowerCase().replace(/\s+/g, "-");
const tabId = (s: Surface) => `surface-tab-${slug(s)}`;
const panelId = (s: Surface) => `surface-panel-${slug(s)}`;
const step = (s: Surface, dir: 1 | -1) =>
  SURFACES[(SURFACES.indexOf(s) + dir + SURFACES.length) % SURFACES.length]!;

function OneModel() {
  const [surface, setSurface] = useState<Surface>("System Map");
  /** false once the visitor takes over, or when they press Pause */
  const [playing, setPlaying] = useState(true);
  /** rotation holds while the pointer or keyboard focus is inside the group */
  const [held, setHeld] = useState(false);
  const [reduced, setReduced] = useState(false);
  const { ref, shown } = useReveal<HTMLElement>();

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (reduced || held || !playing || !shown) return;
    const t = setInterval(() => setSurface((s) => step(s, 1)), 3200);
    return () => clearInterval(t);
  }, [reduced, held, playing, shown]);

  const pick = (s: Surface) => {
    setSurface(s);
    setPlaying(false); // taking over stops the carousel — Play resumes it
  };

  return (
    <section id="one-model" ref={ref} className="mx-auto w-full max-w-[1180px] px-6 py-28 lg:py-36">
      <Reveal>
        <h2 className="max-w-[16ch] text-balance text-[clamp(28px,4vw,44px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
          One model. Every surface.
        </h2>
        <p className="mt-4 max-w-[58ch] text-[15.5px] leading-[1.65] text-ink-mute">
          The map, the source view, the API, and the Navigator agent all read and
          write the same manifest through the same typed actions. Below is one
          fact — <span className="font-mono text-[13.5px] text-ink">web</span> uses{" "}
          <span className="font-mono text-[13.5px] text-ink">cache</span> — on all
          four surfaces. There is no drawing of your system that can disagree
          with your system.
        </p>
      </Reveal>

      <Reveal delay={90} className="mt-10">
        {/* Hover or keyboard focus inside the group holds the rotation; the
            Pause control stops it outright (WCAG 2.2.2). */}
        <div
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="tablist" aria-label="Product surfaces" className="flex flex-wrap gap-1.5">
              {SURFACES.map((s) => (
                <button
                  key={s}
                  id={tabId(s)}
                  type="button"
                  role="tab"
                  aria-selected={surface === s}
                  aria-controls={panelId(s)}
                  tabIndex={surface === s ? 0 : -1}
                  onKeyDown={(e) => {
                    const next =
                      e.key === "ArrowRight"
                        ? step(s, 1)
                        : e.key === "ArrowLeft"
                          ? step(s, -1)
                          : e.key === "Home"
                            ? SURFACES[0]
                            : e.key === "End"
                              ? SURFACES[SURFACES.length - 1]!
                              : undefined;
                    if (!next) return;
                    e.preventDefault();
                    pick(next);
                    document.getElementById(tabId(next))?.focus();
                  }}
                  onClick={() => pick(s)}
                  className={cx(
                    "rounded-[8px] px-3.5 py-2 text-[13px] transition-colors duration-[120ms]",
                    surface === s
                      ? s === "Navigator"
                        ? "bg-nav-dim text-nav-accent"
                        : "bg-signal-dim text-signal"
                      : "text-ink-faint hover:text-ink-mute"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            {/* Nothing rotates under prefers-reduced-motion, so there is
                nothing for this control to do — it isn't rendered. */}
            {!reduced && (
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className={cx(
                  "ml-1 inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-2 text-[12px]",
                  "text-ink-faint transition-colors duration-[120ms] hover:text-ink-mute"
                )}
              >
                {playing ? (
                  <Pause className="h-3 w-3" aria-hidden />
                ) : (
                  <Play className="h-3 w-3" aria-hidden />
                )}
                {playing ? "Pause" : "Play"}
                <span className="sr-only"> the surface rotation</span>
              </button>
            )}
          </div>

          <div className="mt-4 min-h-[240px] rounded-[12px] border border-line bg-bg1 p-6 lg:p-8">
            <p className="mb-5 font-mono text-[11.5px] text-ink-faint">
              the demo system, rendered four ways · simulated
            </p>
            {SURFACES.map((s) => (
              <div
                key={s}
                id={panelId(s)}
                role="tabpanel"
                aria-labelledby={tabId(s)}
                tabIndex={0}
                hidden={surface !== s}
              >
                <SurfacePanel surface={s} />
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function SurfacePanel({ surface }: { surface: Surface }) {
  return (
    <>
      {surface === "System Map" && (
        <svg viewBox="0 0 560 150" className="mx-auto block w-full max-w-[560px]" aria-label="web connected to cache on the System Map">
          <g fill="none" stroke="var(--line-strong)" strokeWidth="1.3">
            <path d="M 196 75 C 260 75, 300 75, 364 75" />
          </g>
          <rect x="40" y="43" width="156" height="64" rx="12" fill="var(--bg2)" stroke="var(--line)" />
          <circle cx="182" cy="57" r="3.4" fill="var(--ok)" />
          <text x="66" y="72" fill="var(--ink)" fontSize="14" fontWeight="600" fontFamily="var(--font-grotesk), 'Space Grotesk', system-ui, sans-serif">web</text>
          <text x="66" y="92" fill="var(--ink-mute)" fontSize="11" fontFamily="var(--font-grotesk), 'Space Grotesk', system-ui, sans-serif">web · standard × 2</text>
          <rect x="364" y="46" width="150" height="58" rx="12" fill="var(--bg2)" stroke="var(--line)" />
          <text x="388" y="73" fill="var(--ink)" fontSize="14" fontWeight="600" fontFamily="var(--font-grotesk), 'Space Grotesk', system-ui, sans-serif">cache</text>
          <text x="388" y="91" fill="var(--ink-mute)" fontSize="11" fontFamily="var(--font-grotesk), 'Space Grotesk', system-ui, sans-serif">redis · small</text>
          <rect x="252" y="64" width="56" height="21" rx="10" fill="var(--bg2)" stroke="var(--line)" />
          <text x="280" y="78" textAnchor="middle" fill="var(--ink-faint)" fontSize="10.5" fontFamily="var(--font-jbmono), 'JetBrains Mono', monospace">cache</text>
        </svg>
      )}
      {surface === "Source" && (
        <pre className="overflow-x-auto font-mono text-[13px] leading-[1.7] text-ink-mute">
{`"bindings": [
  {
    "from": "svc-web",
    "to": "res-cache",
    "capability": `}<span className="text-signal">{`"cache"`}</span>{`,
    "note": "sessions and hot lookups"
  }
]
// injects `}<span className="text-ink">CACHE_URL</span>{` into web at runtime`}
        </pre>
      )}
      {surface === "API" && (
        <pre className="overflow-x-auto font-mono text-[13px] leading-[1.7] text-ink-mute">
{`POST /api/actions/`}<span className="text-signal">system.bind</span>{`
{
  "input": { "from": "web", "to": "cache" },
  "mode": "plan"   // preview first — cost, risk, injected env
}
→ "Connects web to cache and injects CACHE_URL."`}
        </pre>
      )}
      {surface === "Navigator" && (
        <div className="mx-auto max-w-[560px] rounded-[12px] border border-nav-accent/25 bg-bg2 p-5">
          <p className="font-mono text-[12px] text-nav-accent">step 2 · system.bind · low risk</p>
          <p className="mt-2 text-[15px] font-semibold text-ink">Connect web to cache</p>
          <p className="mt-1.5 text-[13.5px] leading-[1.6] text-ink-mute">
            Orrery picks the capability from what cache is, injects the
            connection config into web, and opens the network path. Recorded
            as web → cache; audited like every other step.
          </p>
        </div>
      )}
    </>
  );
}

function PlanFirst() {
  return (
    <section className="border-y border-line bg-bg1">
      <div className="mx-auto grid w-full max-w-[1180px] gap-12 px-6 py-28 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:py-36">
        <Reveal>
          <h2 className="max-w-[14ch] text-balance text-[clamp(28px,4vw,44px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
            Nothing changes silently.
          </h2>
          <p className="mt-4 max-w-[52ch] text-[15.5px] leading-[1.65] text-ink-mute">
            Every edit becomes a changeset: what will happen, what it costs, and
            what could go wrong — before anything applies. Deleting stateful
            things warns you. Production asks for approval. The plan you read is
            the plan that runs.
          </p>
        </Reveal>
        <Reveal delay={120}>
          <figure className="rounded-[12px] border border-line bg-bg2 p-6">
            <figcaption className="flex items-baseline justify-between gap-4">
              <span className="text-[14px] font-semibold text-ink">3 pending changes for staging</span>
              <span className="tnum font-mono text-[12px] text-ink-faint">est $89.50/mo after deploy</span>
            </figcaption>
            <ul className="mt-4 divide-y divide-[var(--line)]">
              {[
                {
                  name: "sessions",
                  what: "Provisions a Redis cache (small).",
                  cost: "+$8.00/mo",
                  risk: "LOW",
                },
                {
                  name: "web → sessions",
                  what: "Connects web to sessions and injects SESSIONS_URL.",
                  cost: "$0.00",
                  risk: "LOW",
                },
                {
                  name: "worker",
                  what: "Updates worker — replicas: 1 → 2.",
                  cost: "+$7.00/mo",
                  risk: "LOW",
                },
              ].map((c) => (
                <li key={c.name} className="flex items-start justify-between gap-4 py-3">
                  <div>
                    <p className="font-mono text-[13px] text-ink">{c.name}</p>
                    <p className="mt-0.5 text-[13px] leading-[1.55] text-ink-mute">{c.what}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <span className="tnum font-mono text-[12px] text-ink-faint">{c.cost}</span>
                    <span className="rounded-[4px] bg-ok-dim px-1.5 py-px font-mono text-[10px] text-ok">{c.risk}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-3.5 font-mono text-[11.5px] text-ink-faint">
              demo plan · costs are estimates · nothing deploys until you say so
            </p>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}

function LiveMoment({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section className="mx-auto w-full max-w-[1180px] px-6 py-28 lg:py-36">
      <div className="mx-auto max-w-[760px] text-center">
        <Reveal rise>
          <h2 className="text-balance text-[clamp(40px,6vw,72px)] font-bold leading-[1] tracking-[-0.025em] text-ink">
            Every deploy ends with{" "}
            <span className="text-signal">Live.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-[54ch] text-[15.5px] leading-[1.65] text-ink-mute">
            Not a green checkmark buried in a log — a panel with your URL, your
            outputs, and your health, the moment they exist. You will never
            deploy something and then hunt for where it went.
          </p>
        </Reveal>
        <Reveal delay={120} className="mt-10">
          <div className="mx-auto max-w-[560px] rounded-[12px] border border-line bg-bg2 p-6 text-left">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-[12px] text-ink-faint">web</p>
                <p className="mt-1 font-mono text-[14.5px] text-ink">https://app.atlas.orrery.app</p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <CopyChip text="https://app.atlas.orrery.app" label="the demo URL" />
                {/* This goes into Orrery, not to the demo host — so it says so
                    and wears the same arrow as every other CTA on the page. */}
                <Link
                  href={cta.href}
                  className="inline-flex items-center gap-1.5 rounded-[8px] bg-signal px-3.5 py-1.5 font-mono text-[12.5px] font-semibold text-on-signal"
                >
                  {cta.label}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              {["web 2/2 healthy", "worker 2/2 healthy", "now est $89.50/mo"].map((chip) => (
                <span key={chip} className="tnum rounded-[6px] bg-ok-dim px-2 py-1 font-mono text-[11.5px] text-ok">
                  {chip}
                </span>
              ))}
              <span className="rounded-[6px] border border-line px-2 py-1 font-mono text-[11.5px] text-ink-faint">
                simulated demo
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function NavigatorSection() {
  return (
    <section className="border-y border-line bg-bg1">
      <div className="mx-auto w-full max-w-[1180px] px-6 py-28 lg:py-36">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr]">
          <Reveal>
            <h2 className="max-w-[16ch] text-balance text-[clamp(28px,4vw,44px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
              An agent with a permission system — not a chat box.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[15.5px] leading-[1.65] text-ink-mute">
              Tell it what you want. It plans through the same typed actions you
              click, shows the risk and cost of each step, and only crosses the
              lines you let it cross. Five autonomy levels, from observe-only to
              bounded autonomy — and every action lands in the audit log either
              way.
            </p>
            <div className="mt-7 flex max-w-[420px] items-center justify-between rounded-full border border-line bg-bg2 px-4 py-2.5">
              {/* the product's five levels, spelled exactly as the product spells them */}
              {["observe", "plan", "approve", "bounded", "autonomous"].map((l, i) => (
                <span
                  key={l}
                  className={cx(
                    "font-mono text-[11px]",
                    i === 2 ? "rounded-[6px] bg-nav-dim px-2 py-0.5 text-nav-accent" : "text-ink-faint"
                  )}
                >
                  {l}
                </span>
              ))}
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="rounded-[12px] border border-nav-accent/25 bg-bg2 p-6">
              <p className="font-mono text-[13px] text-ink-mute">
                <span className="text-nav-accent">▸</span> add a redis cache and bind it to web, set a $100 budget, then deploy to staging
              </p>
              <ol className="mt-5 space-y-3">
                {[
                  { t: "Add Redis cache “sessions”", a: "system.addResource", risk: "low", auto: true },
                  { t: "Connect web to sessions", a: "system.bind", risk: "low", auto: true },
                  { t: "Set a $100/month budget on staging", a: "env.setBudget", risk: "low", auto: true },
                  { t: "Deploy to staging", a: "deploy.apply", risk: "high", auto: false },
                ].map((s, i) => (
                  <li key={s.a} className="flex items-start gap-3.5 rounded-[10px] border border-line bg-bg1 p-3.5">
                    <span className="tnum mt-0.5 font-mono text-[11px] text-ink-faint">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold text-ink">{s.t}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{s.a}</p>
                    </div>
                    {s.auto ? (
                      <span className="rounded-[4px] bg-ok-dim px-1.5 py-px font-mono text-[10px] text-ok">runs</span>
                    ) : (
                      <span className="rounded-[4px] bg-warn-dim px-1.5 py-px font-mono text-[10px] text-warn">
                        needs your approval
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              <p className="mt-4 font-mono text-[11.5px] text-ink-faint">
                the approval boundary is real — this is what it looks like in the product
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const AVAILABILITY_STYLE: Record<ProviderRow["availability"], string> = {
  available: "bg-ok-dim text-ok",
  preview: "bg-warn-dim text-warn",
  planned: "border border-line text-ink-faint",
};

function Honesty({ providers }: { providers: ProviderRow[] }) {
  return (
    <section id="honesty" className="mx-auto w-full max-w-[1180px] px-6 py-28 lg:py-36">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr]">
        <Reveal>
          <h2 className="max-w-[14ch] text-balance text-[clamp(28px,4vw,44px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
            We label things like adults.
          </h2>
          <div className="mt-6 space-y-4 text-[15.5px] leading-[1.65] text-ink-mute">
            <p>Simulated things say <em className="not-italic text-ink">simulated</em>. Costs say <em className="not-italic text-ink">estimate</em>. Disabled controls tell you why. Errors name their fix.</p>
            <p>
              And the provider table below isn&apos;t marketing — it is read live
              from the product&apos;s own registry, so this page cannot claim a
              cloud we haven&apos;t shipped.
            </p>
          </div>
        </Reveal>
        <Reveal delay={120}>
          <ul className="divide-y divide-[var(--line)] rounded-[12px] border border-line bg-bg1">
            {providers.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold text-ink">{p.displayName}</p>
                  <p className="mt-0.5 max-w-[46ch] text-[12.5px] leading-[1.55] text-ink-faint">{p.tagline}</p>
                </div>
                <span
                  className={cx(
                    "mt-0.5 shrink-0 rounded-[6px] px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.06em]",
                    AVAILABILITY_STYLE[p.availability]
                  )}
                >
                  {p.availability}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function NoLockIn() {
  return (
    <section className="border-y border-line bg-bg1">
      <div className="mx-auto grid w-full max-w-[1180px] gap-12 px-6 py-28 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-36">
        <Reveal>
          <figure className="rounded-[12px] border border-line bg-bg2">
            <figcaption className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="font-mono text-[12px] text-ink-mute">providers_override.tf</span>
              <span className="font-mono text-[11px] text-ink-faint">from your export bundle</span>
            </figcaption>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.7] text-ink-mute">
{`# the ONLY LocalStack-specific file.
#
# >>> Moving to real AWS: `}<span className="text-signal">DELETE THIS FILE</span>{`
# >>> and supply real credentials.
# >>> Nothing else in this bundle changes.

provider "aws" {
  endpoints { s3 = "http://localhost:4566" … }
}`}
            </pre>
          </figure>
        </Reveal>
        <Reveal delay={120}>
          <h2 className="max-w-[14ch] text-balance text-[clamp(28px,4vw,44px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
            Leaving must be easy.
          </h2>
          <p className="mt-4 max-w-[52ch] text-[15.5px] leading-[1.65] text-ink-mute">
            Everything exports: the manifest, real runnable Terraform, and an
            operations README that explains how to keep going without us. Test
            against LocalStack on your own machine; when you&apos;re ready for
            real AWS, the difference is one deleted file. You stay because the
            map is good — not because the exit is locked.
          </p>
          <ul className="mt-6 space-y-2 font-mono text-[13px] text-ink-mute">
            {["orrery.manifest.json", "*.tf — validated, fmt-clean", "README.md — life after Orrery"].map((f) => (
              <li key={f} className="flex items-center gap-2.5">
                <span aria-hidden className="h-1 w-1 rounded-full bg-signal" />
                {f}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function Close({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-28 lg:pt-40">
      <div className="text-center">
        <Reveal rise>
          <h2 className="mx-auto max-w-[14ch] text-balance text-[clamp(36px,6vw,68px)] font-bold leading-[1.02] tracking-[-0.025em] text-ink">
            Ship something small tonight.
          </h2>
        </Reveal>
        <Reveal delay={100}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={cta.href}
              className={cx(
                "inline-flex items-center gap-2 rounded-[10px] bg-signal px-7 py-3.5 text-[15px] font-semibold text-on-signal",
                "transition-transform duration-[120ms] hover:scale-[1.02] active:scale-[0.99]"
              )}
            >
              {cta.label}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <CopyChip text="npm run seed && npm run dev" label="the run commands" />
          </div>
        </Reveal>
      </div>
      <footer className="mt-24 flex flex-col items-center justify-between gap-4 border-t border-line pt-8 sm:flex-row">
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="relative inline-block h-[14px] w-[14px] rounded-full border border-signal">
            <span className="absolute -top-[2.5px] left-[7px] h-[5px] w-[5px] rounded-full bg-signal" />
          </span>
          <span className="font-mono text-[12px] text-ink-faint">Orrery v0.1 · a working name</span>
        </span>
        <nav className="flex flex-wrap items-center justify-center gap-5 font-mono text-[12px] text-ink-faint">
          {/* Somewhere to read before clicking. There is no public docs site
              yet, so these are the two places on this page that explain the
              product, plus the repo paths the docs actually live at. */}
          <a href="#one-model" className="transition-colors hover:text-ink">
            How it works
          </a>
          <a href="#honesty" className="transition-colors hover:text-ink">
            What ships today
          </a>
          <Link href={cta.href} className="transition-colors hover:text-ink">
            {cta.label}
          </Link>
        </nav>
      </footer>
      <p className="mt-5 text-center font-mono text-[11.5px] text-ink-faint">
        The written docs ship with the source, not on a website:{" "}
        <span className="text-ink-mute">docs/DESIGN.md</span>,{" "}
        <span className="text-ink-mute">docs/CONTRACTS.md</span>,{" "}
        <span className="text-ink-mute">docs/LIMITATIONS.md</span>.
      </p>
    </section>
  );
}

/* ---------------------------------- page ----------------------------------- */

export function Landing({
  hasWorkspace,
  providers,
  signedIn,
}: {
  hasWorkspace: boolean;
  providers: ProviderRow[];
  /** true/false when accounts are on; null in local demo mode (no auth) */
  signedIn: boolean | null;
}) {
  const cta =
    signedIn === false
      ? { href: hasWorkspace ? "/login" : "/signup", label: hasWorkspace ? "Sign in" : "Create account" }
      : hasWorkspace
        ? { href: "/overview", label: "Open Orrery" }
        : { href: "/onboarding", label: "Begin" };

  return (
    <div className="bg-bg0 text-ink">
      <a
        href="#main"
        className={cx(
          "sr-only rounded-[8px] bg-signal px-4 py-2 text-[13px] font-semibold text-on-signal",
          "focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
        )}
      >
        Skip to content
      </a>
      <Header cta={cta} />
      <main id="main">
        <Hero cta={cta} />
        <OneModel />
        <PlanFirst />
        <LiveMoment cta={cta} />
        <NavigatorSection />
        <Honesty providers={providers} />
        <NoLockIn />
        <Close cta={cta} />
      </main>
    </div>
  );
}
