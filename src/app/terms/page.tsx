import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/shell/wordmark";
import styles from "../privacy/privacy.module.css";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The basic terms for using Zenith accounts, collaborative workspaces, and deployment tools.",
  alternates: { canonical: "https://tryzenith.cloud/terms" },
};

const sections = [
  ["using", "Using Zenith"],
  ["accounts", "Accounts and workspaces"],
  ["content", "Your content and permissions"],
  ["operations", "Deployments and connected services"],
  ["acceptable-use", "Acceptable use"],
  ["availability", "Availability and responsibility"],
  ["ending", "Ending your use"],
  ["updates", "Privacy and updates"],
] as const;

export default function TermsPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#terms-content">Skip to terms of service</a>
      <header className={styles.header}>
        <Link href="/" aria-label="Zenith home"><Wordmark size={24} /></Link>
        <Link href="/login" className={styles.signIn}>Sign in <span aria-hidden="true">↗</span></Link>
      </header>
      <main id="terms-content" className={styles.main}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Working together, clearly</p>
          <h1>Terms of service.</h1>
          <p className={styles.lead}>The basic responsibilities that come with using Zenith.</p>
          <p className={styles.updated}>Last updated <time dateTime="2026-09-28">September 28, 2026</time></p>
        </div>
        <div className={styles.body}>
          <nav className={styles.contents} aria-label="Terms of service sections">
            <p>On this page</p>
            <ol>{sections.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>
          </nav>
          <article className={styles.article} aria-label="Zenith terms of service">
            <p>These terms apply to the Zenith website and deployment workspace at <a href="https://tryzenith.cloud">tryzenith.cloud</a>. By using the service, you agree to these terms. If you do not agree, do not use the service.</p>
            <section id="using" aria-labelledby="using-title">
              <h2 id="using-title">01 <span>Using Zenith</span></h2>
              <p>Zenith provides tools to describe infrastructure, review changes and collaborate on deployment work. Use Zenith only where you are legally able to agree to these terms. If you act for an organization, you must have authority to act on its behalf.</p>
              <p>Features may be limited by your account, workspace permissions, service configuration or admission status. Joining a waitlist does not guarantee access or a particular release date.</p>
            </section>
            <section id="accounts" aria-labelledby="accounts-title">
              <h2 id="accounts-title">02 <span>Accounts and workspaces</span></h2>
              <p>Provide accurate account information and protect your sign-in methods, sessions, credentials and connected accounts. Do not share access in ways that bypass workspace permissions.</p>
              <p>Owners and administrators are responsible for choosing collaborators and reviewing the access they grant. Only invite people you are authorized to invite, and only change or transfer ownership when you have authority to do so. Each collaborator is responsible for their own actions.</p>
            </section>
            <section id="content" aria-labelledby="content-title">
              <h2 id="content-title">03 <span>Your content and permissions</span></h2>
              <p>You retain your rights in the source code, instructions, configurations and other content you submit. You must have the rights and permissions needed to submit that content and allow Zenith to process it.</p>
              <p>You give Zenith permission to store, process and display your content as needed to provide the service and carry out the actions you request, including sharing it with authorized collaborators and connected providers. This permission does not transfer ownership of your content.</p>
            </section>
            <section id="operations" aria-labelledby="operations-title">
              <h2 id="operations-title">04 <span>Deployments and connected services</span></h2>
              <p>Review proposed changes, target environments, access permissions and estimated costs before approving operations. Generated instructions and estimates can be incomplete or incorrect. Keep appropriate backups and recovery plans for systems you operate.</p>
              <p>Connect only infrastructure and third-party accounts you are authorized to manage. Those services have their own terms, limits and charges. You are responsible for charges incurred through your provider accounts; an estimate displayed in Zenith is not a guarantee of a provider’s final bill.</p>
              <p>Signing out of Zenith or stopping use of the website does not necessarily stop resources already running with a cloud provider. Review and manage those resources with the relevant provider.</p>
            </section>
            <section id="acceptable-use" aria-labelledby="acceptable-use-title">
              <h2 id="acceptable-use-title">05 <span>Acceptable use</span></h2>
              <p>Do not use Zenith to break applicable laws, infringe others’ rights, distribute malware, steal credentials, access systems without permission, or interfere with the service or other users. Do not bypass access controls or use another person’s account without authorization.</p>
              <p>We may restrict access or remove content when reasonably necessary to address abuse, security threats, violations of these terms or legal requirements.</p>
            </section>
            <section id="availability" aria-labelledby="availability-title">
              <h2 id="availability-title">06 <span>Availability and responsibility</span></h2>
              <p>Zenith is an evolving service. Features can change, and interruptions, errors or loss of data can occur. Unless separately agreed in writing, these terms do not provide an uptime commitment or a guarantee that a deployment or recovery will succeed.</p>
              <p>You remain responsible for reviewing outputs and deciding whether an operation is appropriate for your systems. Nothing in these terms excludes or limits rights or responsibilities that applicable law does not permit to be excluded or limited.</p>
            </section>
            <section id="ending" aria-labelledby="ending-title">
              <h2 id="ending-title">07 <span>Ending your use</span></h2>
              <p>You can stop using Zenith at any time. Before leaving a workspace, arrange any necessary ownership transfer, retain copies of content you need, and review connected services and running resources.</p>
              <p>Stopping use, revoking Google sign-in or leaving a workspace does not automatically delete account records or shared workspace content. See the privacy policy for information about retention and deletion.</p>
            </section>
            <section id="updates" aria-labelledby="updates-title">
              <h2 id="updates-title">08 <span>Privacy and updates</span></h2>
              <p>Our <Link href="/privacy">Privacy Policy</Link> explains how Zenith handles information and describes available choices and privacy requests.</p>
              <p>For questions about these terms or legal notices, contact <a href="mailto:support@tryzenith.cloud">support@tryzenith.cloud</a>.</p>
              <p>These terms may be updated as the service changes. The date at the top identifies the current version. Review this page when using new features; any notice or consent required by applicable law will still apply.</p>
            </section>
          </article>
        </div>
      </main>
      <footer className={styles.footer}><Link href="/">Back to Zenith</Link><Link href="/privacy">Privacy policy</Link><span>Terms of service · September 2026</span></footer>
    </div>
  );
}
