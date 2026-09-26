# Google sign-in and connected accounts

Google can create an account or sign in to an existing account from `/login` and `/signup`. The same account can connect Google from **Account → Sign-in → Ways to sign in**. Google-only accounts can set a password in the adjacent password card; Google remains available afterward.

## Hosted Supabase setup

1. Create a Google Cloud OAuth client of type **Web application**. Configure branding, authorized domains, and the consent audience. For access beyond named test users, publish the Google OAuth consent configuration for your intended audience.
2. In Google’s **Authorized redirect URIs**, register the Supabase callback: `https://<project-ref>.supabase.co/auth/v1/callback` (or the callback shown by Supabase when using a custom auth domain). This is the provider callback, not the Zenith route.
3. In Supabase **Authentication → Sign In / Providers → Google**, enable Google and enter that client ID and secret. Keep email verification and nonce verification enabled. Zenith requests basic authentication only; it does not request access to Google Drive, Gmail, or offline tokens.
4. In Supabase **Authentication → URL Configuration**, set the production Site URL and allow Zenith’s callback, including its continuation query parameters: `https://<zenith-host>/auth/callback**`. Add local or preview hosts explicitly when needed. Avoid broad production hostname wildcards.
5. Enable **manual identity linking** in Supabase Authentication settings so signed-in users can connect Google to their existing account. Accounts already belonging to another Supabase user are not merged by Zenith.
6. Set `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=google` (or `github,google` to retain GitHub). Rebuild/redeploy: this is a public build-time setting. Keep the existing public Supabase URL and publishable key configured.
7. Enable email confirmations for email/password signup. Workspace invitations are addressed to verified email owners; disabling confirmation would allow somebody to register an address they do not control and accept its invitation.
8. Configure SMTP for confirmation, password recovery, and password reauthentication emails. Match the project password policy to the app minimum of eight characters; stronger Supabase policy is honored and its rejection is displayed.

Google’s client secret belongs in Supabase’s provider configuration, never in a `NEXT_PUBLIC_` variable. No Supabase service-role key is needed for Google sign-in, linking, or setting a password.

## Local Supabase

`supabase/config.toml` enables email confirmations and manual linking and includes a Google block that is disabled until real credentials are supplied. Set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in the environment read by the Supabase CLI, change `[auth.external.google].enabled` to `true`, then restart the local stack. Register `http://127.0.0.1:54321/auth/v1/callback` with Google. Start Zenith on `http://localhost:3400` and set `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=google` in the app environment.

Email signup requires opening its confirmation link; the local Supabase mail inbox is available at `http://localhost:54324`. The local stack still starts without Google credentials when the provider is disabled. The checked-in file does not configure a hosted Supabase project; apply hosted provider and manual-linking settings separately in its dashboard.

## Identity and access behavior

- Supabase performs verified provider authentication and its supported automatic linking for matching verified email addresses. Zenith does not merge accounts by user-submitted email or metadata.
- **Connect Google** starts `linkIdentity`, not `signInWithOAuth`. A same-origin JSON request records the initiating verified user and a random ten-minute correlation value in an HttpOnly cookie. The callback verifies that the existing session and exchanged session still belong to that user, and checks the provider is present. A changed account aborts the flow; an unexpected exchanged account is locally signed out.
- Cancellation, expired links, already-linked identities, and provider failures produce fixed messages. Provider-supplied error text is never rendered from a query string. Google’s account picker appears so people with multiple Google accounts can choose deliberately.
- The final sign-in method cannot be removed. Email identities are managed through the email/password controls, not the OAuth unlink control. An email identity alone does not prove a password exists.
- Password setup uses the authenticated Supabase user. Existing password changes verify credentials, and Supabase’s secure-password-change challenge is supported when the project requires one. Configure Supabase secure password change in production as appropriate; a recent authenticated Google session may set its first password without an old password.
- OAuth and email-confirmation callbacks preserve safe invitation/recovery continuations, reject external or malformed return URLs, and exchange PKCE codes server-side. Workspace resolution runs inside a Postgres store scope and flushes accepted invitations before redirecting.
- When the optional waitlist gate is enabled, the exchanged user must be admitted before workspace resolution. Existing account-link callbacks are gated as well. Verified password-recovery callbacks remain available while a user is waiting. Google configuration itself does not enable the waitlist.

## Verification

Automated tests cover OAuth button requests and retries, safe redirects, PKCE exchange, waitlist gating, store-scope persistence, same-account linking, cancellation, expired/mismatched link state, and password setup/change interactions.

Before production rollout, use two real Google accounts to verify first sign-in, repeat sign-in, connecting Google to an existing email account, cancellation and already-linked refusal, and setting a password followed by email/password sign-in. Provider configuration and real consent require deployment-owned credentials and cannot be confirmed by mocked tests.

References: [Supabase Google authentication](https://supabase.com/docs/guides/auth/social-login/auth-google), [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking), [redirect allowlists](https://supabase.com/docs/guides/auth/redirect-urls), and [local configuration](https://supabase.com/docs/guides/local-development/cli/config).
