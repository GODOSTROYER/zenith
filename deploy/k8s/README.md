# J11 infrastructure pin boundary

The three checked-in images are explicit zero-digest placeholders until actual local release images exist. A syntactic
`@sha256:` suffix is insufficient: `scripts/deploy/pin-digests.mjs --check` rejects zeros and all floating owned bases.
Run `--todo` offline for the complete resolution list. The Mac-only resolver rewrites the exact `image:` fields from real
registry manifest digests after all requested lookups succeed; it does not alter deployment settings or use credentials.

Do not apply these manifests with placeholders. Commands for local builds, image resolution, replay and the existing
rolling-upgrade rehearsal are in `docs/build/production/verify/OPS-03.md`; chart archive resolution and kind installation
are in `MAN-04.md`. Images from a loopback registry need verifier-owned kind registry wiring. Runtime/probe compatibility,
schema upgrade, rollback and tenant isolation remain real acceptance gates, not consequences of a pin rewrite.
