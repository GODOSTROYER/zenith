import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/shell/wordmark";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Zenith handles account information, workspace content, Google sign-in, integrations and privacy requests.",
  alternates: { canonical: "https://tryzenith.cloud/privacy" },
};

const sections = [
  ["information", "Information we handle"],
  ["google", "Google sign-in"],
  ["use", "How information is used"],
  ["sharing", "Who can access it"],
  ["browser", "Cookies and browser storage"],
  ["retention", "Retention and deletion"],
  ["choices", "Your choices"],
  ["contact", "Questions and updates"],
] as const;

export default function PrivacyPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#privacy-content">Skip to privacy policy</a>
      <header className={styles.header}>
        <Link href="/" aria-label="Zenith home"><Wordmark size={24} /></Link>
        <Link href="/login" className={styles.signIn}>Sign in <span aria-hidden="true">↗</span></Link>
      </header>
      <main id="privacy-content" className={styles.main}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Your information, in view</p>
          <h1>Privacy policy.</h1>
          <p className={styles.lead}>What Zenith handles, why it is needed, and the choices you have.</p>
          <p className={styles.updated}>Last updated <time dateTime="2026-09-28">September 28, 2026</time></p>
        </div>
        <div className={styles.body}>
          <nav className={styles.contents} aria-label="Privacy policy sections">
            <p>On this page</p>
            <ol>{sections.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>
          </nav>
          <article className={styles.article} aria-label="Zenith privacy policy">
            <p>This policy covers the Zenith website and deployment workspace at <a href="https://tryzenith.cloud">tryzenith.cloud</a>. Zenith lets you describe infrastructure, review changes and collaborate with your team. Applications you build or operate with Zenith may have their own privacy notices and data practices.</p>

            <section id="information" aria-labelledby="information-title">
              <h2 id="information-title">01 <span>Information we handle</span></h2>
              <ul>
                <li><strong>Account information.</strong> Your email address, account identifier, display name, profile image when supplied by a sign-in provider, linked sign-in methods and authentication records. Supabase handles sign-in credentials and sessions.</li>
                <li><strong>Workspace content.</strong> Workspace names, memberships, invitations and roles; project definitions, source you submit, infrastructure settings, revisions, deployment records, logs, activity history and configured secrets.</li>
                <li><strong>Requests and integrations.</strong> Instructions you give Navigator or a connected agent, and the connection details and permissions you provide for integrations.</li>
                <li><strong>Waitlist information.</strong> If waitlist registration is available and you join, we store your email, occupation, primary use case, submission time and admission status.</li>
                <li><strong>Technical information.</strong> Requests to the service generate operational and security logs, which can include IP addresses, browser information, request times and errors. Where enabled, waitlist abuse protection uses a keyed hash of your IP address for rate limiting.</li>
              </ul>
            </section>

            <section id="google" aria-labelledby="google-title">
              <h2 id="google-title">02 <span>Google sign-in</span></h2>
              <p>When Google sign-in is available and you choose it, Google shares basic identity information with Zenith through Supabase: your Google account identifier, email address and verification status, and profile information such as your name and picture. We use this information to create or authenticate your Zenith account, display your profile and link your sign-in methods.</p>
              <p>Zenith does not receive your Google password. This sign-in flow does not request access to Gmail messages, Google Drive files, contacts or calendars. Google identity information is handled as account information; signing in does not itself send it to an AI provider.</p>
              <p>You can review or revoke Zenith’s connection in your <a href="https://myaccount.google.com/connections">Google Account connections</a>. Revoking that connection does not delete information already stored in Zenith.</p>
            </section>

            <section id="use" aria-labelledby="use-title">
              <h2 id="use-title">03 <span>How information is used</span></h2>
              <p>We use this information to authenticate users, enforce access permissions, maintain workspaces, prepare and carry out supported operations you request, show change history, diagnose failures and protect the service against abuse. Waitlist information supports reviewing registrations and granting access.</p>
              <p>If Navigator’s AI translation is enabled, your instruction and relevant context—service and resource names and types, and environment names and classes—are sent to Anthropic to interpret your request. Anything you include in that instruction is part of the submission. Avoid putting passwords or unrelated personal information in prompts.</p>
            </section>

            <section id="sharing" aria-labelledby="sharing-title">
              <h2 id="sharing-title">04 <span>Who can access it</span></h2>
              <p><strong>Your collaborators.</strong> Workspace members can access content according to their roles. Sharing a workspace gives others access to its information; administrators and owners can manage membership and permissions.</p>
              <p><strong>Service providers.</strong> Zenith uses Vercel to host the website and application, and Supabase for authentication and database storage. These providers process information needed to deliver their services. Anthropic receives the prompt and context described above when that optional feature is enabled.</p>
              <p><strong>Connections you choose.</strong> Connected agents can receive information within the permissions you grant. Configured notification channels and other integrations receive information needed for the action you request, such as an alert or an export. Their operators have their own privacy practices.</p>
              <p><strong>Zenith operators.</strong> Privileged operators can access stored account and workspace information to operate and troubleshoot the service. Access controls and encryption do not make your workspace content unreadable to the service operator.</p>
              <p>Provider processing can occur in locations outside your country. This policy does not promise that all information remains in one country or region.</p>
            </section>

            <section id="browser" aria-labelledby="browser-title">
              <h2 id="browser-title">05 <span>Cookies and browser storage</span></h2>
              <p>Zenith uses cookies for authentication and sign-in security. Local and session storage remember preferences and working state, such as your theme, selected environment, onboarding progress and dismissed guidance. Blocking these features can prevent sign-in or cause preferences to be forgotten.</p>
              <p>You can clear this information through your browser settings. Clearing browser storage does not delete account or workspace information stored on the server.</p>
            </section>

            <section id="retention" aria-labelledby="retention-title">
              <h2 id="retention-title">06 <span>Retention and deletion</span></h2>
              <p>Account, workspace and waitlist records are stored to support the service and its history. Zenith does not currently apply a single automatic deletion period to all records. Removing an account or leaving a workspace does not automatically erase shared project content, revision authorship or audit history.</p>
              <p>Self-service account deletion is not currently available for the production database. Contact the operator to request access, correction or deletion of your information. Requests require verification of your identity and may need coordination with workspace owners. Backup and operational records may remain after a change to active data; immediate erasure from every copy is not guaranteed.</p>
            </section>

            <section id="choices" aria-labelledby="choices-title">
              <h2 id="choices-title">07 <span>Your choices</span></h2>
              <p>You can manage available account settings, sign out, choose which workspaces to join and revoke connected agent access. Workspace owners and administrators can manage collaborators using Share. Owners must transfer ownership before leaving a workspace.</p>
              <p>You can choose whether to use optional Google sign-in, AI features and integrations. Review the permissions and information involved before connecting a service or sharing a workspace.</p>
            </section>

            <section id="contact" aria-labelledby="contact-title">
              <h2 id="contact-title">08 <span>Questions and updates</span></h2>
              <p>For privacy questions or requests, contact the Zenith operator at <a href="mailto:support@tryzenith.cloud">support@tryzenith.cloud</a>. Do not post passwords, secrets or private workspace content in public issues.</p>
              <p>This page will be updated as Zenith’s features and data practices change. The date above identifies the latest revision.</p>
            </section>
          </article>
        </div>
      </main>
      <footer className={styles.footer}><Link href="/">Back to Zenith</Link><Link href="/terms">Terms of service</Link><span>Privacy policy · September 2026</span></footer>
    </div>
  );
}
