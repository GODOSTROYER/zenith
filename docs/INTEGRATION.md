# Product and Gimbal integration review — 2026-09-06

## Review boundary

Work is on `codex/orrery-integration`, based on `security-hardening` at
`e38cf87`. Nothing was pushed or deployed. Existing Gimbal improvements were
preserved and included. The pre-existing `.gitignore` edit remains uncommitted.
No authentication configuration or user data was changed for browser testing.

## Design overview

The observatory identity remains: layered navy surfaces, mint primary actions,
restrained violet Navigator identity, and distinct semantic status colors.
The Impeccable refinement playbook guided hierarchy, accessible controls and
the bounded visual review; this is a refinement, not a replacement visual world.

- Workspace identity sits beside the wordmark; project/environment navigation
  stays visible and production is marked in amber.
- New project is a first-class action above the project cards. Empty filtering
  has a working recovery action, and environment links are easier to scan.
- Task pages share headings and responsive gutters. Settings has section
  anchors that track reading position and reveal the active item on mobile.
- Controls have larger targets and visible focus, mobile text fields avoid
  auto-zoom, and editable table cells retain their arrow-key behavior.
- Sign-in uses one clear form frame. Dark and light text/status tokens are
  covered by 4.5:1 contrast regression tests.
- Gimbal has smooth ring transitions, runtime low-power/still modes, resilient
  WebGL fallback, and five status glows with paired text/icons. Completed,
  cancelled and simulated outcomes do not borrow the Verified success state.
- Verification is scoped to authoritative provider evidence for the applied
  run. Currently it covers managed default-config LocalStack S3/SQS resources
  in supported deploy-only runs (with optional plan/investigate steps), not
  arbitrary services or mixed operations. Unsupported scope stays neutral.

## Branch inventory and selection

After fetching origin, these feature tips were already ancestors of the base:

| Branch | Tip | Treatment |
| --- | --- | --- |
| landing-page | `3a7cd70` | Already included |
| auth-supabase | `9bbdae0` | Already included |
| build-plan | `9b659dc` | Already included |
| master | `72aee57` | Already included |
| gimbal | `10c68c4` | Already included |
| security-hardening | `e38cf87` | Integration base |

`origin/feat/landing-page-visual-refresh` at `6047f59` has unrelated git history.
Its incremental changes were reviewed from `4b099ef` through `6047f59` and
selectively adapted, not merged wholesale:

| Remote change | Decision |
| --- | --- |
| Next.js patch (`ccee665`) | Retained exact Next 15.5.24 with matching eslint-config-next and lockfile; exclude generated next-env.d.ts from lint |
| Consumer-facing copy (`6047f59`) | Adapted opening and closing headlines plus opening explanation |
| Automatic Vercel `/tmp` store (`13d4728`) | Excluded: workspace state would become ephemeral |
| Pinned horizontal GSAP sequence (`ff642f8`) | Excluded: duplicate workflow story, scroll takeover and new dependency |
| Extra font, decorative effects, invented metrics/actions | Excluded: preserve self-hosted typography, actual action IDs and honest simulation/provider labels |
| Older auth/server baseline | Excluded: unrelated stale history must not replace current security work |

## Verification and limits

- 889 tests across 79 files passed, including Gimbal state/renderer/fallback,
  provider verification, run-history truthfulness, contrast and UI regressions.
- TypeScript, ESLint and the Next 15.5.24 production build passed.
- The one manual design-pattern scan returned no findings.
- Real localhost landing and sign-in pages were inspected. Landing surface
  switching/pause controls worked; sign-in was not submitted.
- Actual client components were rendered separately at loopback in a labeled
  synthetic-data harness: desktop overview, settings and Navigator; mobile
  project chrome/map/settings. Filter recovery, environment selection,
  settings anchors, empty-deploy map navigation and still-mode selection were
  checked. Mobile settings content overflow was reproduced and fixed.
- The isolated harness disables infrastructure mutations and mocks routing/data.
  It is not evidence of authenticated end-to-end workflows. Full authenticated
  regression, live LocalStack readback and Docker smoke remain unverified in
  this review. No passwords were reset and no live deployments were executed.
- Temporary review assets are outside the repository; representative screenshots
  are retained in the local Codex visualization directory for the handoff.

The product/skill context metadata has older schema/path conventions. This
review did not rewrite that unrelated configuration.
