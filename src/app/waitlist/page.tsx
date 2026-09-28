import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/shell/wordmark";
import { ArrowUpRight } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { getWaitlistAccess } from "@/lib/waitlist/access";
import { waitlistEnabled } from "@/lib/waitlist/config";
import { authPageUrl } from "@/lib/auth/oauth";
import { safeNextPath } from "@/lib/auth/destination";
import { WaitlistJoinForm } from "./waitlist-join-form";
import styles from "./waitlist.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join the waitlist", description: "A clearer view of your cloud is coming. Join the Zenith early access waitlist.", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, interactiveWidget: "resizes-content" };

export default async function WaitlistPage({ searchParams }: { searchParams?: Promise<{ next?: string | string[] }> }) {
  const query = await searchParams;
  const requested = safeNextPath(typeof query?.next === "string" ? query.next : undefined);
  // A waitlist continuation must never send an admitted account back to this page.
  const next = requested && !/^\/waitlist(?:[/?#]|$)/.test(requested) ? requested : undefined;
  const continuation = next ? `/auth/continue?next=${encodeURIComponent(next)}` : "/auth/continue";
  const user = await getSessionUser();
  if (user && (await getWaitlistAccess(user)).allowed) redirect(continuation);
  const intakeEnabled = waitlistEnabled();

  return <div className={`${styles.surface} ${styles.page}`}>
    <header className={styles.pageHeader}>
      <Link href="/" aria-label="Zenith home"><Wordmark size={23} /></Link>
      {user ? <form action="/auth/signout" method="post"><button type="submit">Sign out</button></form> : <Link href={authPageUrl("/login", next)}>Sign in <ArrowUpRight size={15} aria-hidden="true" /></Link>}
    </header>
    <main className={styles.pageMain}>
      <div className={styles.pageIntro}>
        <p className={styles.eyebrow}>Zenith · Early access</p>
        <h1 className={styles.title}>Your next<br /><em>great beginning.</em></h1>
        <p className={styles.description}>Your cloud, in full view. Join the waitlist for a calmer way to build, deploy, and grow.</p>
        <div className={styles.pageLine} aria-hidden="true" />
        <p className={styles.pageNote}>We’re opening access in small batches. Leave your email and help shape what comes next.</p>
      </div>
      <section className={styles.pageForm} aria-label="Join the Zenith waitlist">
        {user && <p className={styles.account}>Your email is verified. Product access still needs approval. Join the waitlist below.<br /><a href={continuation}>Check your access again <span aria-hidden="true">↗</span></a></p>}
        {intakeEnabled ? <WaitlistJoinForm email={user?.email || ""} name={user?.name || ""} emailReadOnly={Boolean(user?.email)} next={next} /> : <p className={styles.paused}>New waitlist requests are paused for now. If you’ve already joined, your place is safe. Please check back soon.</p>}
      </section>
    </main>
    <footer className={styles.pageFooter}><span>Your cloud. Your control.</span><nav aria-label="Legal"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:support@tryzenith.cloud">Contact</a></nav></footer>
  </div>;
}
