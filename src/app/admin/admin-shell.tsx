import type { ReactNode } from "react";
import Link from "next/link";
import { Activity, Archive, ArrowUpRight, History, LayoutDashboard, ListChecks, Orbit, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import styles from "./admin.module.css";

export function AdminShell({ email, showRetention = false, children }: { email: string; showRetention?: boolean; children: ReactNode }) {
  return (
    <div className={`${styles.theme} ${styles.shell}`}>
      <a className={styles.skipLink} href="#admin-main">Skip to administration</a>
      <aside className={styles.sidebar} aria-label="Administration navigation">
        <Link href="/" aria-label="Zenith home" className={styles.brand}><Wordmark size={23} /></Link>
        <div className={styles.workspaceLabel}><ShieldCheck size={15} aria-hidden="true" /> Mission control</div>
        <nav className={styles.navigation}>
          <a href="#overview"><LayoutDashboard size={17} aria-hidden="true" /> Overview</a>
          <a href="#waitlist"><ListChecks size={17} aria-hidden="true" /> Waitlist</a>
          <a href="#approval-history"><History size={17} aria-hidden="true" /> Approval history</a>
          {showRetention ? <Link href="/admin/slo"><Activity size={17} aria-hidden="true" /> Service objectives</Link> : null}
          {showRetention ? <Link href="/admin/retention"><Archive size={17} aria-hidden="true" /> Data retention</Link> : null}
        </nav>
        <div className={styles.sidebarFooter}>
          <p>Owner access</p><p className={styles.ownerEmail}>{email}</p>
          <form action="/auth/signout" method="post"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
        </div>
      </aside>
      <div className={styles.content}>
        <header className={styles.topbar}>
          <span className={styles.consoleLabel}><span aria-hidden="true" /> Zenith / Owner console</span>
          <div className="flex items-center gap-3"><Link href="/auth/continue">Open Zenith <ArrowUpRight size={14} aria-hidden="true" /></Link><form className={styles.mobileSignout} action="/auth/signout" method="post"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form></div>
        </header>
        <main id="admin-main" className={styles.main}>
          <div className={styles.pageHeading}>
            <div className={styles.headingCopy}><span className={styles.eyebrow}>Mission 01 / Early access</span><h1>Make room<br />for the next <em>builders.</em></h1><p>Review the waitlist. Meet the minds behind the requests. You clear them for launch.</p></div><div className={styles.orbitalArt} aria-hidden="true"><div className={styles.orbitRing} /><div className={styles.orbitRingInner} /><div className={styles.planet}><Orbit size={42} strokeWidth={1} /></div><span className={styles.orbitDot} /><span className={styles.orbitCaption}>GOOD IDEAS NEED SPACE</span></div>
            <span className={styles.privateLabel}><ShieldCheck size={14} aria-hidden="true" /> Private console</span>
          </div>
          {children}
          <footer className={styles.creatorFooter}><span>Built by <a href="https://www.arnavbule.in" target="_blank" rel="noopener noreferrer">Arnav Bule <ArrowUpRight size={12} aria-hidden="true" /></a>. A little ambition. A lot of orbit.</span><a href="https://github.com/GODOSTROYER" target="_blank" rel="noopener noreferrer">GODOSTROYER on GitHub <ArrowUpRight size={12} aria-hidden="true" /></a></footer>
        </main>
      </div>
    </div>
  );
}
