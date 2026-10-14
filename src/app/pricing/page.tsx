import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/shell/wordmark";
import { PACKAGE_ROWS, listPlanViews, type PlanView } from "@/lib/billing/plans";
import { HEADER_LEAD, HEADER_TITLE, PUBLIC_STATUS, ctaFor, fairUseLine } from "./plan-copy";
import styles from "./pricing.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Zenith launch pricing: Explore, Builder, Team and Enterprise. Deploy and manage applications in your cloud, or let Zenith host them.",
  alternates: { canonical: "https://tryzenith.cloud/pricing" },
};

/** Static: the plans are read from the in-code catalog at build time; no auth, no database. */
export const dynamic = "force-static";

function Cta({ plan }: { plan: PlanView }) {
  const cta = ctaFor(plan);
  return cta.href ? <a className={styles.cta} href={cta.href}>{cta.label}</a> : <span className={styles.salesText}>{cta.label}</span>;
}

export default function PricingPage() {
  const plans = listPlanViews();
  const zcu = plans[0].zcu;
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#pricing-content">Skip to pricing</a>
      <header className={styles.header}>
        <Link href="/" aria-label="Zenith home"><Wordmark size={24} /></Link>
        <Link href="/login" className={styles.signIn}>Sign in <span aria-hidden="true">↗</span></Link>
      </header>
      <main id="pricing-content" className={styles.main}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Plans</p>
          <h1>{HEADER_TITLE}</h1>
          <p className={styles.lead}>{HEADER_LEAD}</p>
        </div>
        <ul className={styles.cards} aria-label="Plans">
          {plans.map((plan) => (
            <li key={plan.id} className={styles.card} data-plan={plan.id}>
              <h2>{plan.name}</h2>
              <p className={styles.bestFor}>{plan.display.bestFor}</p>
              <p className={styles.price}>{plan.display.monthlyPrice}</p>
              <dl className={styles.facts}>
                <div><dt>Included management usage</dt><dd>{plan.display.includedUsage}</dd></div>
                <div><dt>Additional management usage</dt><dd>{plan.display.additionalUsage}</dd></div>
                <div><dt>Deployment options</dt><dd>{plan.display.deploymentOptions}</dd></div>
                <div><dt>Support</dt><dd>{plan.display.support}</dd></div>
              </dl>
              <Cta plan={plan} />
            </li>
          ))}
        </ul>
        <section className={styles.section} aria-labelledby="compare-title">
          <h2 id="compare-title">Compare plans</h2>
          <div className={styles.tableWrap} role="region" aria-label="Plan comparison table" tabIndex={0}>
            <table className={styles.table}>
              <caption>What each Zenith plan includes</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  {plans.map((plan) => <th key={plan.id} scope="col">{plan.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {PACKAGE_ROWS.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {plans.map((plan) => <td key={plan.id}>{plan.display[row.key]}</td>)}
                  </tr>
                ))}
                <tr>
                  <th scope="row">Get started</th>
                  {plans.map((plan) => <td key={plan.id}><Cta plan={plan} /></td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.section} aria-labelledby="zcu-title">
          <h2 id="zcu-title">How management usage is measured</h2>
          <p className={styles.note}>{zcu.definition}</p>
        </section>
        <section className={styles.section} aria-labelledby="fair-title">
          <h2 id="fair-title">Fair use</h2>
          <p className={styles.note}>Build minutes and storage are included in every plan and are never charged. Each plan has a monthly limit; at the limit Zenith refuses new work that would use more until the next month, and reading or exporting your data is never blocked.</p>
          <ul className={styles.fair} aria-label="Monthly fair-use limits">
            {plans.map((plan) => <li key={plan.id}><strong>{plan.name}</strong>{fairUseLine(plan)}</li>)}
          </ul>
        </section>
        <section className={styles.section} aria-labelledby="status-title">
          <h2 id="status-title">Where pricing stands</h2>
          <p className={styles.status}>{PUBLIC_STATUS}</p>
        </section>
      </main>
      <footer className={styles.footer}><Link href="/">Back to Zenith</Link><Link href="/privacy">Privacy policy</Link><Link href="/terms">Terms of service</Link></footer>
    </div>
  );
}
