/**
 * The HTTP edge of app access — now one module up, at `@/lib/server/hosted`.
 *
 * The wrapper, the body reader and the owner check that used to be declared
 * here were declared twice more (`hosted/release/http.ts`, and `hosted()` under
 * `app/api/hosted/ops/`). They are one implementation now, and it lives at L5
 * where importing `server/*` is the normal direction — which is what removes
 * the `hosted/access/http.ts → server/context` cycle docs/MODULE-MAP.md lists.
 *
 * This file stays as the import path it always was. Note it is deliberately
 * **not** re-exported from `access/index.ts`: the gateway and the job runner
 * import that barrel, and neither should be dragging the /api request layer in
 * behind it.
 */
export {
  RoleSchema,
  hostedJson,
  hostedRoute,
  readJsonBody,
  requireAppOwner,
  signedInUser,
  verifiedIdentity,
  type AppOwner,
  type HostedGrant,
  type HostedRouteOptions,
  type HostedVerify,
  type OwnerCheck,
  type ReadBodyOptions,
} from "@/lib/server/hosted";
