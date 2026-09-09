# Zenith identity and compatibility

Zenith means the point directly above the observer. The product promise is
**Your stack, clearly in view.** Visibility means understanding the current
system, the next change, and the evidence behind an outcome—not claiming
universal cloud control or production readiness.

## Identity

The corporate symbol is the Shift Register: two authored solid vector shapes
with offset edges and a diagonal seam. It accompanies original lowercase
zenith vector lettering, not font outlines. The shared master geometry is in
`src/components/shell/brand-geometry.ts`; the existing `OrbitMark` and
`Wordmark` exports remain compatible with product callers. The visible `.ai`
suffix and accessible Zenith name preserve the product name. Monochrome,
inverse and small symbol treatments share this identity. Gimbal's moving rings
belong to the Navigator character and are not the corporate mark.

The landing direction is **The Revision Object**: porcelain, ink and controlled
vermilion make the next infrastructure change tangible. Instrument Serif
roman/italic supplies editorial display type, Manrope supplies body and controls,
and the existing JetBrains Mono supplies technical evidence. All font files are
self-hosted with their license notices. Both landing themes are intentionally
composed; the dark inspect/review chapter and closing signature keep their ink
ground in either theme. Proposed work earns the vermilion accent; a recorded
queue settles into porcelain with a small revision tab.

Product workflows extend the approved Revision Object identity into a compact operational workbench: porcelain/ink surfaces, vermilion actions and proposed changes, selective Instrument Serif titles, Manrope controls and JetBrains Mono technical data. The landing keeps its own composition and display scale. Success is green, warnings and production identity amber, errors berry, information blue and Navigator violet. Every meaningful state needs text or an icon; color alone is insufficient.

Gimbal introduces itself neutrally and responds to a voluntary greeting. Its
landing appearance shares the product renderer, reduced-motion handling,
low-power mode and WebGL fallback. A greeting is never a Verified event.

## Product language

- Zenith is the platform; Gimbal is its mascot; Navigator is its planning
  and execution surface.
- A workspace holds projects, connections and membership. A project holds an
  editable system; an environment selects where a revision runs.
- Creating a project is not deploying it. A plan is not an applied change.
- LocalStack provisions supported S3/SQS resources locally. Other emulated
  features must keep their simulation labels.
- AWS Preview plans and exports Terraform. It does not call AWS, validate IAM,
  apply changes or measure live account health.
- Azure and Oracle are Coming later, not working connections.
- Prefer concrete, calm explanations over superlatives or defensive marketing.

## Compatibility boundary

This rebrand changes presentation, not the identity of existing user data.
Keep `ORRERY_*` configuration variables, `orrery-theme` and other browser/store
namespaces, cookies, package identity, API/action/provider IDs, persisted
workspace/project IDs, user-defined names and domains, Terraform tags/addresses,
and `orrery.manifest.json`/archive names compatible. Existing audit history and
Gimbal asset provenance remain historical records. Human-readable explanations
can say Zenith while showing those literal configuration keys and filenames.

Illustrations use reserved example domains; existing project domains are not
rewritten. The Zenith name does not establish ownership of that internet
domain, and this work does not configure or publish to it.

## First useful outcome

Gimbal helps a new user establish a workspace, choose an explicit connection,
create an editable blueprint project, and understand the next safe action.
The workspace guide remains discoverable and can be revisited without creating
anything. Setup facts come from actual scoped records; optional guide reading
must not stand in for a deployment or provider verification.

The final order is workspace → choose how to start → blueprint → review your
system. Workspace establishes ownership. Outcome-led mode cards explain local
operations, AWS planning/export or simulation before blueprint selection,
without asking for credentials. LocalStack defaults to the supported bucket/
queue starter; AWS and simulation default to an application blueprint. The
next action opens the actual project/environment (Source for AWS), while the
screen guide remains optional. A compulsory tour or automatic deploy is not
part of setup.

## Production-use boundary

This is a production-oriented improvement, not a production-readiness certificate.
The local JSON store still has a one-process/data-directory constraint. AWS apply
and live AWS observability remain unimplemented. Secret-key backup/recovery,
durable database migration, production auth/provider configuration, independent
security review and operational recovery testing still need an explicit plan
before a multi-user production deployment. See `LIMITATIONS.md` and `RUNNING.md`.

## Compatibility fixes included with the rollout

New Compose and Dockerfile imports scope vault references by project, service
and environment-variable key. Reimport keeps existing references—including
legacy bare references—so stored values are not silently disconnected.

Referenced-resource Terraform variables retain their old names when unique.
Only ambiguous names receive stable identity-derived suffixes; the exported
README lists the old key and replacements. Existing noncolliding SSM paths,
including hyphenated resource names, are preserved. Review the mapping before
reusing tfvars from an export that had collisions.

Connection **Declared access** describes the current adapter's implementation.
The stored granted-permissions snapshot, status and last-check timestamp remain
historical evidence. Loading bootstrap does not perform a cloud check or rewrite
that history. AWS Preview currently requests no IAM access.
