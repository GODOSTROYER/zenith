import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Wordmark, OrbitMark } from "@/components/shell/wordmark";
import { LandingCta } from "./landing-cta";
import type { Cta } from "./cta";

export function LandingClose({ cta }: { cta: Cta }) {
  return (
    <section className="zenith-close" aria-labelledby="zenith-close-title">
      <div className="zenith-close-main"><div><h2 id="zenith-close-title">Make your next change<br /><em>a clear one.</em></h2><p>Start with an editable blueprint.<br />Make the next decision with the whole system in view.</p><div className="zenith-close-actions"><LandingCta cta={cta} /><Link href="/guide" className="zenith-text-link">Explore the guide <ArrowUpRight size={16} aria-hidden="true" /></Link></div></div><div className="zenith-close-symbol" aria-hidden="true"><OrbitMark size={320} /></div></div>
      <footer className="zenith-footer"><a href="#main" aria-label="Zenith.ai home"><Wordmark size={26} /></a><p>The next change, made tangible.</p><nav aria-label="Footer navigation"><Link href="/login">Sign in</Link><Link href="/guide">Guide</Link><a href="https://github.com/GODOSTROYER/zenith" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={13} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a></nav></footer>
    </section>
  );
}
