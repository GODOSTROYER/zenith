# Zenith and Gimbal acceptance

## Delivered

- Zenith identity across the app, metadata and product documentation, with
  a shared vector mark and a neutral, voluntary Gimbal landing introduction.
- Optional journey: workspace ownership → outcome-led start mode → appropriate
  blueprint → review the actual system. No credential collection or automatic
  deployment. The guide covers Overview, System, Source, Deploys, Revisions,
  Observe, Security, Activity, Navigator and Settings.
- User/workspace-scoped resume, explicit provider choice, fresh-state checks,
  interrupted-import recovery using the saved project, and a guide escape path
  when a signed-in account has no workspace yet.
- Scoped imported secret references, compatibility-preserving Terraform
  disambiguation, and current declared access separated from stored check history.

## Verification

- TypeScript, ESLint and production build passed. Regression tests cover
  first-user bootstrap 403, forbidden existing members, returning-user refresh,
  newly created second-project selection, foreign workspace drafts, role gates,
  unavailable LocalStack, import retry, secret isolation, Terraform collisions,
  SSM path preservation and explicit collision migration notes.
- Browser checked against the authenticated local production app, not a mock
  dashboard: existing workspace selection; AWS Preview → blueprint → refresh;
  existing-project guide; ten screen destinations and their environment query;
  neutral Gimbal greeting; disabled unavailable LocalStack; desktop and mobile.
- Browser checks created no workspace, project, connection or deployment, and
  changed no external account. First-user creation UI and recovery are exercised
  by automated DOM/API tests; no new hosted-auth account was created for QA.
- The bounded visual pass found mobile export-panel overflow and a crowded
  header; both were corrected. Color still has text labels, Gimbal supports
  low-power/still modes, and existing reduced-motion/fallback tests remain.

## Boundaries

AWS remains Preview: no account reads, IAM verification, apply or live AWS
observability. LocalStack was not running during browser QA; the unreachable
state was verified, not a live local deployment. Azure and Oracle are Coming
later. No cloud deployment or external Terraform apply was performed.

Existing data, API identifiers, configuration keys and export filenames remain
compatible. The unrelated `.gitignore` edit is not included. This is not a
production-readiness certification: the one-process JSON store, secret-key
recovery, production auth/configuration and operational recovery still require
deployment-specific review. See `BRANDING.md` and `LIMITATIONS.md`.
