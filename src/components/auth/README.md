# components/auth — sign-in surfaces

`auth-shell.tsx` is the responsive editorial/form frame the four `(auth)` routes share,
`auth-form.tsx` is the form itself (sign in, sign up, forgot, reset), and
`messages.ts` maps a provider error code to a sentence that names the fix —
pure, and tested.

The routes under `src/app/(auth)/**` stay thin: they pick a mode and render
these. Never put a provider-specific error string in a page.

The shared Revision Object tokens style configured forms, account recovery and
the unconfigured local-demo state. The form stays the primary task on narrow
screens; the longer workflow explanation is desktop-only. Authentication,
redirect and recovery behavior remains inside the existing form implementation.

`oauth-button.tsx` shares provider controls with Account settings. Google uses
the unchanged official `public/brands/google-g.png` asset from
[Google Identity](https://developers.google.com/identity/branding-guidelines).
The four-color edge carries hover, focus, and pending feedback; the mark stays
still. Reduced motion retains a static edge and an announced loading state.
