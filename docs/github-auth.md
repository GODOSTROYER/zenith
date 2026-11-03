# GitHub sign-in and repository access

GitHub sign-in identifies the person using Zenith. Repository import uses the separate Zenith GitHub App. A person may sign in with Google and connect selected GitHub repositories without adding GitHub as a sign-in method.

## Hosted Supabase setup

1. Register a GitHub **OAuth App** for this environment. Its callback is the URL shown by the Supabase GitHub provider, normally `https://<project-ref>.supabase.co/auth/v1/callback`.
2. In Supabase Authentication, enable GitHub and store its OAuth client ID and secret. Never put the secret in a public variable or in the Zenith GitHub App configuration.
3. Configure Zenith's Site URL and exact allowed `/auth/callback` destinations, including safe continuation parameters. Use separate development/staging/production registrations when callbacks differ.
4. Enable manual identity linking so existing Google/email users can connect GitHub from **Account → Sign-in**. Keep verified-email checks enabled. Zenith never merges accounts by username or client-supplied email.
5. Set `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=google,github` and rebuild the Next.js app. Provider buttons are deliberately opt-in; setting this variable does not configure Supabase.
6. Apply `supabase/migrations/0028_github_waitlist_identity.sql`. Keep the existing waitlist hook and cutoff. Google and GitHub can establish a waiting identity; admission remains checked before workspace provisioning and product access. Other unadmitted account creation remains blocked.

Zenith requests no `repo` scope from sign-in. Repository import uses installation consent, selected repositories, and scoped read tokens; see [GitHub App setup](platform/operations/BUILDS.md).

## Local development

The GitHub block in `supabase/config.toml` is disabled until credentials exist. Supply `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` to the Supabase CLI, enable `[auth.external.github]`, and restart the local stack. Register the actual local Supabase callback, normally `http://127.0.0.1:54321/auth/v1/callback`. Keep credentials out of git. Zenith's local origin remains `http://localhost:3400`.

## Identity lifecycle

- Use **Connect GitHub** while signed in to attach GitHub to the existing Zenith account. A different verified email does not require creating another workspace/account first.
- Hidden public GitHub email is not itself an error; Supabase obtains the provider's authenticated email result. A missing usable email must not bypass admission or invitation verification.
- Callback state is bound to the initiating account and expires. Cancellation, conflicts, and changed-account callbacks retain the existing account and offer retry.
- Removing GitHub sign-in does not disconnect repository grants. Manage repository access in workspace repository settings.
- Removing the final usable sign-in method is blocked. Verify the alternate method before unlinking.

## Acceptance

Automated tests exercise provider requests, PKCE linking for both Google and GitHub, callback boundaries, and the real hook SQL in PGlite plus the opt-in PostgreSQL contract lane. Before release, verify real GitHub consent with configured credentials: admitted/new/waitlisted users, hidden email, an existing Google account with a different GitHub email, cancellation, an already-linked identity, and unlink protection. Mocked tests do not establish a working hosted provider configuration.

References: [Supabase GitHub authentication](https://supabase.com/docs/guides/auth/social-sign-in/auth-github), [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking), and [GitHub App installation](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).
