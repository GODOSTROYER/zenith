"use client";

import Link from "next/link";
import { useRef, type CSSProperties } from "react";
import { ArrowUpRight, Download, FileCode2, FileJson2, FileText } from "lucide-react";
import { OrbitMark, Wordmark } from "@/components/shell/wordmark";
import { cx } from "@/lib/format";
import { LandingCta } from "./landing-cta";
import type { Cta } from "./cta";
import { useHighlight } from "./landing-experience";
import { useFan, useReveal } from "./landing-motion";
import styles from "./chapters.module.css";
import local from "./close-chapter.module.css";

/** The three files that leave with you, named as the export names them. */
const EXPORTS = [
  { icon: FileJson2, name: "zenith.manifest.json", title: "Infrastructure definition" },
  { icon: FileCode2, name: "Terraform / *.tf", title: "Real Terraform for AWS" },
  { icon: FileText, name: "Operations / README.md", title: "Operations guide" },
];

/** Own, then the close, in the shape of the original: the invitation on the left, the mark on the right, the footer as it was. */
export function CloseChapter({ cta }: { cta: Cta }) {
  const highlight = useHighlight("close");
  const section = useRef<HTMLElement>(null);
  const sheets = useRef<HTMLUListElement>(null);
  useReveal(section);
  useFan(sheets);
  return (
    <section ref={section} id="close" data-chapter="close" className={cx("zenith-ink", styles.chapter, local.close)} aria-labelledby="close-title">
      <div className={styles.inner}>
        <div className={local.ownership} data-reveal-group>
          <ul ref={sheets} className={cx(local.sheets, styles.region)} data-hot={highlight?.region === "exports" || undefined} aria-labelledby="ownership-title" data-reveal>
            {EXPORTS.map(({ icon: Icon, name, title }, index) => (
              <li key={name} className={local.sheet} style={{ "--i": index } as CSSProperties}>
                <i className={local.sheetIcon}><Icon size={20} aria-hidden="true" /></i>
                <span className={local.sheetBody}><span className={local.sheetName}>{name}</span><span className={local.sheetTitle}>{title}</span></span>
                <span className={local.sheetIndex} aria-hidden="true">{index === EXPORTS.length - 1 ? <Download size={17} /> : String(index + 1).padStart(2, "0")}</span>
              </li>
            ))}
          </ul>
          <div className={local.ownCopy}>
            <h2 id="ownership-title" className={local.ownTitle} data-reveal>The system<br /><em>stays yours.</em></h2>
            <p className={local.ownText} data-reveal>Three files leave with you. Their contents belong in your editor.</p>
            <span className={local.roadmap} data-reveal><i />Roadmap · compliance assistance for human review, not automation</span>
          </div>
        </div>
        <div className={local.main} data-reveal-group>
          <div>
            <h2 id="close-title" data-reveal>Reach<br /><em>the zenith.</em></h2>
            <p className={local.tagline} data-reveal>Make your next change <em>a clear one.</em></p>
            <p className={local.body} data-reveal>Start with an editable blueprint.<br />Make the next decision with the whole system in view.</p>
            <div className={local.actions} data-reveal><LandingCta cta={cta} /><Link href="/guide" className="zenith-text-link">Explore the guide <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
          </div>
          <div className={local.symbol} aria-hidden="true" data-reveal><OrbitMark size={320} /></div>
        </div>
        <footer className="zenith-footer"><a href="#main" aria-label="Zenith home"><Wordmark size={26} /></a><p>The next change, made tangible.</p><nav aria-label="Footer navigation"><Link href="/login">Sign in</Link><Link href="/guide">Guide</Link></nav></footer>
      </div>
    </section>
  );
}
