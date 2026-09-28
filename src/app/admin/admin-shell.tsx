import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, History, LayoutDashboard, ListChecks, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import styles from "./admin.module.css";

export function AdminShell({ email, children }: { email: string; children: ReactNode }) {
  return (
    <div className={`${styles.theme} ${styles.shell}`}>
      <a className={styles.skipLink} href="#admin-main">Skip to administration</a>
      <aside className={styles.sidebar} aria-label="Administration navigation">
        <Link href="/" aria-label="Zenith home" className={styles.brand}><Wordmark size={23} /></Link>
        <div className={styles.workspaceLabel}><ShieldCheck size={15} aria-hidden="true" /> Administration</div>
        <nav className={styles.navigation}>
          <a href="#overview"><LayoutDashboard size={17} aria-hidden="true" /> Overview</a>
          <a href="#waitlist"><ListChecks size={17} aria-hidden="true" /> Waitlist</a>
          <a href="#approval-history"><History size={17} aria-hidden="true" /> Approval history</a>
        </nav>
        <div className={styles.sidebarFooter}>
          <p>Owner access</p><p className={styles.ownerEmail}>{email}</p>
          <form action="/auth/signout" method="post"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
        </div>
      </aside>
      <div className={styles.content}>
        <header className={styles.topbar}>
          <span>Zenith / Administration</span>
          <div className="flex items-center gap-3"><Link href="/auth/continue">Open Zenith <ArrowUpRight size={14} aria-hidden="true" /></Link><form className={styles.mobileSignout} action="/auth/signout" method="post"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form></div>
        </header>
        <main id="admin-main" className={styles.main}>
          <div className={styles.pageHeading}>
            <div><h1>Early access</h1><p>Get to know the people building with Zenith. Review each request and decide who comes in next.</p></div>
            <span className={styles.privateLabel}><ShieldCheck size={14} aria-hidden="true" /> Private console</span>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
