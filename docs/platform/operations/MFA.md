# Privileged operator MFA

Zenith uses Supabase Auth TOTP for privileged human actions. Set up an authenticator at `/account/mfa/enrol`, then verify at `/account/mfa/challenge`. Review and resubmit the intended action after verification; the screens never replay a refused mutation. Signed AAL2, an unexpired token, a matching confirmed live user and a currently verified TOTP factor are required. Existing workspace roles, approvals, policy and execution checks still apply.

## Local and default stack (J1 join)

The repository's `supabase/config.toml` contains this exact non-secret configuration:

```toml
[auth.mfa]
max_enrolled_factors = 10

[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true
```

J1 must retain this block in its owned prepared Supabase CLI configuration. Use the same pinned CLI, local Auth public URL/key, confirmed disposable identities and private-CA database/pooler wiring as the default stack. Restart only the owned local Auth stack after a configuration change. The TOML config controls the CLI stack; a separately composed Auth container needs the environment settings below. Do not enable SMS or add provider credentials for this TOTP lane. These keys are documented by [Supabase CLI configuration](https://supabase.com/docs/guides/local-development/cli/config).

The assembled release must include platform migrations 44-56 from their owners, followed by **57, `workspace_mfa_controls`**. Before starting the app, load the installation's private database environment and run:

```sh
node --version # pinned Node 22
npx tsx scripts/platform/migrate.ts
```

Run migration tooling against the explicitly owned local/default stack for acceptance. The application checks the PostgreSQL schema and refuses a missing migration; it does not run production DDL automatically. No aggregate SQL snapshot was edited by J3. The assembler regenerates it after assembling all assigned migrations.

## Production Auth configuration

For a self-hosted Supabase/GoTrue Auth service, explicitly set these values in the Auth process configuration (for Compose, put them under `services.auth.environment` in an owned override):

```yaml
GOTRUE_MFA_MAX_ENROLLED_FACTORS: "10"
GOTRUE_MFA_TOTP_ENROLL_ENABLED: "true"
GOTRUE_MFA_TOTP_VERIFY_ENABLED: "true"
```

These names configure factor enrollment and verification, as documented in the upstream [Supabase Auth environment inventory](https://github.com/supabase/supabase/blob/master/docker/CONFIG.md#mfa). Carry them into the actual Auth container, then recreate only that service through the installation's controlled deployment process. Zenith's Next.js environment cannot enable an Auth-server setting. For managed Supabase, confirm TOTP enrollment and verification in the **project's Auth MFA settings**; Zenith users enroll their factors in Zenith. The provider documents both controls in its [MFA guide](https://supabase.com/docs/guides/auth/auth-mfa).

Configure Zenith's public Supabase Auth URL/key and canonical `ZENITH_PLATFORM_ORIGIN` using the installation's existing secret/configuration process. Keep TLS, verified email, admission, membership and operator allowlists. Do not expose database service credentials in the browser. Auth failure, unknown AAL, removed factors and unavailable workspace state refuse privileged actions. An Auth outage has no privileged fallback. This document records required setup; no production Auth service or cloud API was called by this job.

## Workspace-owned controls

At `/platform/settings`, workspace admins can save **Require verification for all changes by people** and an optional verification lifetime of **60..86400 whole seconds**. Blank lifetime uses the authenticated AAL2 session. Privileged actions always require AAL2 and cannot be exempted. Lifetimes use the signed authenticator AMR timestamp, so refreshing a JWT does not restart the timer.

`GET /api/workspace/mfa` returns the selected member workspace's settings and version. `PUT` is browser-only, admin-only and requires step-up under the current settings. Its strict body is `{workspaceId, requireForAllMutations, maxAgeSeconds, expectedVersion}`; null lifetime means the session default. The workspace must match the resolved selection cookie. Version 0 means no saved row; conflicting saves return 409 and require a reload and review. The deprecated `ZENITH_MFA_WORKSPACE_CONTROLS` host map is ignored and must be removed from installation configuration. There is no automatic host-map import or override.

State lives in `platform.workspace_mfa_controls`. Reads without a row return the immutable default and never create state. Tenant-scoped updates and `workspace.mfa_controls_changed` events commit in one SQL transaction. Each event contains the authenticated human ID, request correlation ID, exact before/after enforcement values and versions. It contains no Auth factor, TOTP seed or code. RLS denies direct browser access; the server uses the same service-only access and workspace authorization as sibling settings tables.

Legacy cancellation uses the existing `deploy.cancel` action, guarded by the common MFA route hook and audited by the action runner. A successful step-up grants no role or tenant access. Cancellation stops remaining work; already applied effects remain. An audit write failure must not be reported as confirmed success.

## Acceptance and recovery

Run the real local browser/axe and PostgreSQL commands in [PROD-UX-01 verification](../../build/production/verify/PROD-UX-01.md). Use two distinct disposable admitted admins, fresh password sessions, actual enrollment/challenge and keyboard saves. The lean Mac lane needs one local Auth/API/PostgreSQL stack and one headless browser; it needs no cloud, Temporal or kind. Disabled gates are not acceptance passes.

If an operator loses a factor, use the identity provider's authorized account/factor recovery process and re-enroll through Zenith. Do not disable the route guard or invent an application recovery credential. Back up workspace controls with the platform store and retain their audit history through the installation's existing retention policy. Manual NVDA and operated cancellation remain verifier responsibilities.
