/**
 * system.setSecret / rotateSecret / removeSecret, and the ref-consumer
 * reasoning that decides what each one is allowed to say. Split out of the
 * single-file module; the code is unchanged.
 */
import { z } from "zod";
import {
  defineAction,
  type ActionContext,
} from "@/lib/actions/core";
import {
  type Manifest,
  type Project,
  type Service,
} from "@/lib/domain/types";
import {
  isVaultRef,
  parseVaultRef,
  putSecret,
  removeSecret as removeStoredSecret,
  secretStatus,
  secretStoreState,
  vaultRef,
} from "@/lib/secrets";
import { db, q } from "@/lib/db/store";
import {
  clone,
  requireProject,
  requireService,
} from "../_shared";
import { manifestAction } from "./shared";
/* --------------------------------- secrets --------------------------------- */

/**
 * Zenith holds secret VALUES, encrypted, in `lib/secrets` — and records only
 * the REFERENCE (`vault:<projectId>/<serviceId>/<KEY>`) in the manifest. So
 * these three actions each touch two places, and every plan says which:
 *
 *   manifest  → the reference, which is diffed, revisioned, audited, exported
 *   store     → the value, which is none of those things
 *
 * Without `ORRERY_SECRET_KEY` there is no store, and a write is refused with
 * the variable's name and how to generate a key. It never half-works: a value
 * is never accepted and dropped, and a plaintext value is never replaced by a
 * reference to nothing.
 *
 * IDENTITY — a generated reference names the service that asked for it, so two
 * services that both read DATABASE_URL get two values, not one shared row that
 * a rotation on either would overwrite. `lib/secrets` owns the shape and the
 * reasoning; the rules THESE actions add on top are:
 *
 *   - an explicit `secretRef` always wins, which is how two services are
 *     deliberately pointed at one value;
 *   - a variable that already reads from Zenith's store keeps the reference it
 *     has — including a legacy bare `vault:<KEY>` — because re-pointing it at
 *     a namespaced reference would leave the stored value behind with nothing
 *     naming it;
 *   - nothing deletes a stored value while anything else still references it.
 */

/** True for references this Zenith is responsible for (as opposed to your Vault). */
const isOurs = isVaultRef;

/**
 * The reference a variable writes to, and where that came from — the plan says
 * so, because "this is scoped to this service" and "this is the reference you
 * asked for" are different promises.
 */
function resolveRef(
  project: Project,
  service: Service,
  key: string,
  explicit: string | undefined
): { ref: string; source: "explicit" | "existing" | "generated" } {
  if (explicit) return { ref: explicit, source: "explicit" };
  const current = service.env.find((e) => e.key === key)?.secretRef;
  // Only inherit one of ours: an external ref (aws:…) is a value Zenith cannot
  // write, so a set-with-value there must still fall through to the default and
  // be refused by name rather than silently retargeted.
  if (current && isOurs(current)) return { ref: current, source: "existing" };
  return { ref: vaultRef(project.id, service.id, key), source: "generated" };
}

/** One variable, somewhere in the workspace, that reads from a reference. */
interface RefConsumer {
  projectId: string;
  /** absent only when a live revision's manifest could not be read */
  serviceId?: string;
  key?: string;
  /** "atlas/api.DATABASE_URL", or the same with "(live in staging)" */
  label: string;
  /** true when this consumer is a deployed revision, not the working copy */
  live: boolean;
}

/** Is this consumer the very variable an action is editing? */
const isSelf = (c: RefConsumer, projectId: string, serviceId: string, key: string): boolean =>
  c.projectId === projectId && c.serviceId === serviceId && c.key === key;

const envHits = (m: Manifest, ref: string) =>
  m.services.flatMap((s) => s.env.filter((e) => e.secretRef === ref).map((e) => ({ s, e })));

/**
 * Everything in this workspace that still points at `ref`. The reverse index
 * the store deliberately does not keep: manifests are the truth about who reads
 * what, so this reads them rather than maintaining a second copy that can drift.
 *
 * Two sources, both honest about a value that is still needed:
 *   - the working manifest of every project in the workspace (the current
 *     project's is supplied by the caller, so an edit in progress counts);
 *   - the manifest of each environment's LIVE revision — a redeploy or a
 *     rollback of what is running reads the value again.
 *
 * Cost: one pass over the working manifests already in memory, plus one cold
 * manifest per deployed environment (bounded by environments, not by history).
 */
function refConsumers(
  ctx: ActionContext,
  ref: string,
  view: { projectId: string; manifest: Manifest }
): RefConsumer[] {
  const out: RefConsumer[] = [];
  const seen = new Set<string>();
  const push = (c: RefConsumer) => {
    if (seen.has(c.label)) return;
    seen.add(c.label);
    out.push(c);
  };

  for (const p of db().projects) {
    if (p.workspaceId !== ctx.workspaceId) continue;
    const working = p.id === view.projectId ? view.manifest : p.workingManifest;
    for (const { s, e } of envHits(working, ref))
      push({
        projectId: p.id,
        serviceId: s.id,
        key: e.key,
        label: `${p.name}/${s.name}.${e.key}`,
        live: false,
      });

    for (const environment of q.environmentsOf(p.id)) {
      const revisionId = environment.deployedRevisionId;
      if (!revisionId) continue;
      let deployed: Manifest | undefined;
      // A missing side file throws rather than pretending the revision is
      // empty. Not knowing is not a reason to delete somebody's credential, so
      // treat it as "cannot rule out a consumer" and say so.
      try {
        deployed = q.revisionManifest(revisionId);
      } catch {
        push({
          projectId: p.id,
          label: `${p.name}/${environment.name} (live revision unreadable)`,
          live: true,
        });
        continue;
      }
      if (!deployed) continue;
      for (const { s, e } of envHits(deployed, ref))
        push({
          projectId: p.id,
          serviceId: s.id,
          key: e.key,
          label: `${p.name}/${s.name}.${e.key} (live in ${environment.name})`,
          live: true,
        });
    }
  }
  return out;
}

/** "a/api.DB_URL, b/worker.DB_URL and 2 more" — a list a person can act on. */
function listConsumers(consumers: RefConsumer[], max = 4): string {
  const shown = consumers.slice(0, max).map((c) => c.label);
  const rest = consumers.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** How a generated reference explains itself, once, in the same words. */
const SCOPED_NOTE =
  "It is scoped to this service, so another service's variable of the same name is a different secret. " +
  "To share one value between services, pass that service's secretRef explicitly instead of letting Zenith generate one.";

/** How a plan describes what the store currently holds at a reference. */
function heldLine(ctx: ActionContext, ref: string): string {
  if (!isOurs(ref))
    return `${ref} is not Zenith's to resolve — your provider reads it at deploy time. Zenith only records the name.`;
  const held = secretStatus(ctx.workspaceId, ref);
  return held.exists
    ? `The store already holds a value for ${ref} (v${held.version}, updated ${held.updatedAt} by ${held.updatedBy}). Applying this points at it; the value itself is unchanged.`
    : `Nothing is stored at ${ref} yet. Add the value in the same step, or with system.rotateSecret, before you deploy — a service whose secret is missing starts without it.`;
}

const REDEPLOY_NOTE =
  "Services already running keep the copy they were given at deploy time. They pick this up on the next deploy, not now.";

const SetSecret = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "use letters, digits and underscores, starting with a letter or underscore"),
  /**
   * The value to store. Named `secretValue` so core's audit redactor masks it
   * by field name — it must never reach the audit log, even on a refusal.
   */
  secretValue: z.string().min(1).optional(),
  /**
   * Where the value lives. Left out, it is Zenith's own store under a
   * reference scoped to this project and service —
   * `vault:<projectId>/<serviceId>/<KEY>` — unless the variable already reads
   * from a reference of Zenith's, which it keeps. Pass one explicitly to point
   * this variable at a value another service already uses.
   */
  secretRef: z.string().min(1).optional(),
  /**
   * Take the plaintext value this key already has, put it in the store, and
   * replace it with the reference — one action, so the value is never briefly
   * nowhere. This is what the "Move to the secret store" security fix runs.
   */
  moveExistingValue: z.boolean().optional(),
});
type SetSecret = z.infer<typeof SetSecret>;

manifestAction<SetSecret>({
  id: "system.setSecret",
  title: "Set secret",
  risk: "low",
  input: SetSecret,
  build(project, input, ctx) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const { ref, source } = resolveRef(project, service, input.key, input.secretRef);
    /** what dropping secretRef would give you — named in every refusal below */
    const generated = vaultRef(project.id, service.id, input.key);
    const existing = service.env.find((e) => e.key === input.key);
    const plaintext = existing?.value;
    const store = secretStoreState();
    const what = `Stores ${input.key} as a secret on ${service.name}`;

    /** Who else reads this reference once this edit lands — sharing, out loud. */
    const others = (): RefConsumer[] =>
      refConsumers(ctx, ref, { projectId: project.id, manifest: next }).filter(
        (c) => !isSelf(c, project.id, service.id, input.key)
      );

    /** The line that says which reference this is and why it is that one. */
    const refLine = (): string => {
      if (source === "generated")
        return `The reference ${ref} was generated from this project and service. ${SCOPED_NOTE}`;
      if (source === "existing")
        return (
          `${service.name}.${input.key} already reads from ${ref}` +
          `${parseVaultRef(ref)?.legacy ? ", a reference from before Zenith scoped them to one service" : ""}, ` +
          `so that is where this goes — Zenith does not re-point a variable at a new reference, which would leave the value it has behind with nothing naming it.`
        );
      return `${ref} is the reference you named. Anything else pointing at it reads the same value — that is what sharing a secret between services means here.`;
    };

    const point = (): void => {
      if (existing) {
        existing.secretRef = ref;
        delete existing.value;
      } else {
        service.env.push({ key: input.key, secretRef: ref });
      }
    };

    /* Move: the working copy's plaintext becomes the stored value. */
    if (input.moveExistingValue) {
      if (plaintext === undefined)
        return {
          next,
          what,
          blocked:
            `${service.name}.${input.key} has no plaintext value to move${existing ? ` (it already reads from ${existing.secretRef})` : " — there is no such variable"}. ` +
            `Nothing was changed. To store a new value, run this action with the value instead.`,
        };
      if (!isOurs(ref))
        return {
          next,
          what,
          blocked:
            `Zenith can only move a value into its own store, and ${ref} is somewhere else. ` +
            `Drop secretRef to use ${generated}, or copy the value into ${ref} yourself and then point at it.`,
        };
      if (!store.configured)
        return {
          next,
          what,
          blocked:
            `${store.reason} ${service.name}.${input.key} still holds its plaintext value and was left exactly as it is — moving it now would delete the only copy. ${store.fix}`,
        };
      point();
      const shared = others();
      return {
        next,
        what: `Moves ${input.key} on ${service.name} into the secret store`,
        details: [
          `The value moves from the manifest into Zenith's store under ${ref}, encrypted with this server's ORRERY_SECRET_KEY. The manifest keeps only the reference.`,
          refLine(),
          `The store is written first: if that fails, the plaintext stays where it is and nothing is committed.`,
        ],
        warnings: [
          ...(shared.length
            ? [
                `${listConsumers(shared)} also read ${ref}. This writes the value they will get on their next deploy — check that is the credential you mean for all of them.`,
              ]
            : []),
          `Revisions already recorded still contain the plaintext — this cannot change the past. Rotate the credential at its source if it has been exposed.`,
          REDEPLOY_NOTE,
        ],
        apply: () => putSecret(ctx.workspaceId, ref, plaintext, ctx.actor.name),
        data: { serviceId: service.id, secretRef: ref },
      };
    }

    /* A value was supplied: store it, record the reference. */
    if (input.secretValue !== undefined) {
      if (!store.configured)
        return {
          next,
          what,
          blocked:
            `${store.reason} ${store.fix} ` +
            `Nothing was saved, and the value you typed was not written to the manifest, the store or the audit log. ` +
            `Until then you can still record a reference to a value you keep elsewhere: run this action with secretRef and no value.`,
        };
      if (!isOurs(ref))
        return {
          next,
          what,
          blocked:
            `${ref} is not Zenith's store, and Zenith cannot write into someone else's. ` +
            `Drop secretRef to store the value at ${generated}, or put it in ${ref} yourself and run this action with secretRef and no value.`,
        };

      const held = secretStatus(ctx.workspaceId, ref);
      const value = input.secretValue;
      point();
      const shared = others();
      return {
        next,
        what: held.exists ? `Replaces the stored value for ${input.key} on ${service.name}` : what,
        details: [
          `The value is encrypted with AES-256-GCM under this server's ORRERY_SECRET_KEY and written to the secret store as ${ref}${held.exists ? ` (v${held.version} → v${held.version + 1})` : " (v1)"}.`,
          `The manifest records only ${ref}. No value reaches the manifest, the diff, a revision, the audit log or an export bundle.`,
          refLine(),
        ],
        warnings: [
          ...(shared.length
            ? [
                `${listConsumers(shared)} also read ${ref}, so this replaces the value for ${shared.length === 1 ? "it" : "them"} too, at their next deploy. Store it under a reference of its own instead if that is not what you mean.`,
              ]
            : []),
          ...(plaintext !== undefined
            ? [
                `${input.key} currently holds a plaintext value on ${service.name}. Applying this replaces it with the reference — the value you typed is what gets stored, and the old one survives only in revisions already recorded.`,
              ]
            : []),
          REDEPLOY_NOTE,
        ],
        apply: () => putSecret(ctx.workspaceId, ref, value, ctx.actor.name),
        data: { serviceId: service.id, secretRef: ref },
      };
    }

    /* Reference only: point at a value that already exists somewhere. */
    if (plaintext !== undefined)
      return {
        next,
        what,
        blocked:
          `${input.key} currently holds a plaintext value on ${service.name}, and replacing it with ${ref} would delete the only copy in the working manifest. ` +
          (store.configured
            ? `Run this action again with moveExistingValue: true to put that value in Zenith's store and swap in the reference in one step — nothing is lost.`
            : `${store.reason} ${store.fix} Or copy the value into your own secret manager, remove it here with system.setEnvVar (value: null), and then add the reference.`),
      };

    point();
    const shared = others();
    return {
      next,
      what: `Points ${input.key} at the secret ${ref} on ${service.name}`,
      details: [
        `The manifest records only the reference ${ref}. No value is written to the manifest, the diff, the audit log or an export bundle.`,
        refLine(),
        heldLine(ctx, ref),
        ...(shared.length
          ? [
              `${listConsumers(shared)} read the same reference, so ${service.name}.${input.key} shares one value with ${shared.length === 1 ? "it" : "them"} — rotating it changes what they all read.`,
            ]
          : []),
      ],
      data: { serviceId: service.id, secretRef: ref },
    };
  },
});

/* --------------------------- rotate: value only ---------------------------- */

/**
 * Which reference an input names: an explicit one, or the one the service's
 * variable already points at. Throws with the fix when neither resolves.
 */
function requireRef(
  project: Project,
  input: { serviceId?: string; key?: string; secretRef?: string }
): string {
  if (input.secretRef) return input.secretRef;
  if (!input.serviceId || !input.key)
    throw new Error(
      "Say which secret: pass secretRef, or both serviceId and key so Zenith can read the reference off the variable."
    );
  const service = requireService(project.workingManifest, input.serviceId);
  const entry = service.env.find((e) => e.key === input.key);
  if (!entry)
    throw new Error(`${service.name} has no variable "${input.key}". Add it with system.setSecret first.`);
  if (!entry.secretRef)
    throw new Error(
      `${service.name}.${input.key} holds a plaintext value, not a secret reference. Move it into the store with system.setSecret (moveExistingValue: true) before rotating it.`
    );
  return entry.secretRef;
}

const RotateSecret = z.object({
  projectId: z.string().optional(),
  /** name the secret directly… */
  secretRef: z.string().min(1).optional(),
  /** …or name the variable that points at it */
  serviceId: z.string().optional(),
  key: z.string().optional(),
  secretValue: z.string().min(1),
});
type RotateSecret = z.infer<typeof RotateSecret>;

/**
 * A new value under the same reference. The manifest does not change at all —
 * which is the point, and why this is not a manifestAction: there is no diff
 * to preview, so the plan describes the store instead.
 */
defineAction<RotateSecret>({
  id: "system.rotateSecret",
  title: "Rotate secret",
  category: "secrets",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: RotateSecret,
  plan(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const ref = requireRef(project, input);
    const store = secretStoreState();
    const base = {
      summary: `Replaces the stored value for ${ref}.`,
      details: [] as string[],
      warnings: [] as string[],
      costDeltaUsd: 0,
      risk: "medium" as const,
      requiresApproval: false,
    };

    if (!store.configured) return { ...base, blocked: `${store.reason} ${store.fix}` };
    if (!isOurs(ref))
      return {
        ...base,
        blocked:
          `${ref} is not held by Zenith — it names a value in your own secret manager, which Zenith cannot write to. ` +
          `Rotate it there, then redeploy so the services pick it up.`,
      };
    const held = secretStatus(ctx.workspaceId, ref);
    if (!held.exists)
      return {
        ...base,
        blocked:
          `Nothing is stored at ${ref}, so there is nothing to rotate. ` +
          `Set the first value with system.setSecret on the variable that references it.`,
      };

    // Everything that reads this reference gets the new value. Usually that is
    // one variable — a generated reference names one service — but a shared
    // reference, or a legacy `vault:<KEY>` from before references carried
    // identity, can be several, and a rotation is the moment to say so.
    const readers = refConsumers(ctx, ref, {
      projectId: project.id,
      manifest: project.workingManifest,
    });

    return {
      ...base,
      details: [
        `${ref} goes from v${held.version} to v${held.version + 1}. The new value is encrypted under this server's ORRERY_SECRET_KEY and replaces the old one, which is not recoverable afterwards.`,
        `The manifest, the working copy and every revision are untouched — they hold the reference, never the value.`,
        readers.length <= 1
          ? `${readers.length === 1 ? readers[0].label : "Nothing in this workspace"} reads ${ref}, so nothing else changes.`
          : `${readers.length} variables read ${ref} and all of them get the new value: ${listConsumers(readers)}.`,
      ],
      warnings: [
        ...(readers.length > 1
          ? [
              `${ref} is shared. Rotating it re-credentials ${listConsumers(readers)} together — if only one of them should change, give that one its own reference with system.setSecret first.`,
            ]
          : []),
        REDEPLOY_NOTE,
      ],
    };
  },
  execute(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const ref = requireRef(project, input);
    const store = secretStoreState();
    if (!store.configured)
      return { ok: false, summary: "The secret was not rotated.", error: `${store.reason} ${store.fix}` };
    if (!isOurs(ref))
      return {
        ok: false,
        summary: "The secret was not rotated.",
        error: `${ref} lives in your own secret manager. Rotate it there, then redeploy.`,
      };
    if (!secretStatus(ctx.workspaceId, ref).exists)
      return {
        ok: false,
        summary: "The secret was not rotated.",
        error: `Nothing is stored at ${ref}. Set the first value with system.setSecret.`,
      };

    const meta = putSecret(ctx.workspaceId, ref, input.secretValue, ctx.actor.name);
    return {
      ok: true,
      summary: `${ref} is now v${meta.version}. ${REDEPLOY_NOTE}`,
      data: { secretRef: ref, version: meta.version },
    };
  },
});

/* ------------------------- remove: reference + value ------------------------ */

const RemoveSecret = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().min(1),
});
type RemoveSecret = z.infer<typeof RemoveSecret>;

manifestAction<RemoveSecret>({
  id: "system.removeSecret",
  title: "Remove secret",
  risk: "medium",
  input: RemoveSecret,
  build(project, input, ctx) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const entry = service.env.find((e) => e.key === input.key);
    if (!entry)
      throw new Error(
        `${service.name} has no variable "${input.key}". It may already be gone — reload the service to see what it has.`
      );
    if (!entry.secretRef)
      throw new Error(
        `${service.name}.${input.key} is a plain value, not a secret. Remove it with system.setEnvVar (value: null).`
      );

    const ref = entry.secretRef;
    const held = isOurs(ref) ? secretStatus(ctx.workspaceId, ref) : { exists: false as const, ref };
    service.env = service.env.filter((e) => e.key !== input.key);

    /*
     * WHO ELSE STILL NEEDS THIS VALUE.
     *
     * `next` already has this variable removed, so what comes back is exactly
     * who would be left reading the stored value after this edit lands: other
     * services and other projects in the workspace, and the live revisions a
     * rollback would replay. The variable being removed counts only through a
     * live revision — that copy is still deployed and would be read again.
     *
     * Policy when there IS someone left: remove the reference, KEEP the value.
     *
     * Refusing the whole edit was the alternative and it is the worse one. The
     * manifest half is per-service and reversible (every revision has it); the
     * store half is shared and unrecoverable, so those two halves do not
     * deserve the same answer. A refusal would also be theatre: `setEnvVar
     * (value: null)` already drops the same reference and leaves the value, so
     * blocking here would only push people onto a path that says less. What is
     * never allowed is the destructive half — a value another service is still
     * declared to read is not deleted here on any path.
     */
    const remaining = isOurs(ref)
      ? refConsumers(ctx, ref, { projectId: project.id, manifest: next }).filter(
          (c) => c.live || !isSelf(c, project.id, service.id, input.key)
        )
      : [];
    const keepsValue = remaining.length > 0;

    return {
      next,
      what: keepsValue
        ? `Removes ${input.key} from ${service.name} and keeps the value ${remaining.length === 1 ? "its other reader" : "its other readers"} still need`
        : `Removes the secret ${input.key} from ${service.name}`,
      details: [
        `The reference ${ref} is removed from the manifest.`,
        held.exists && keepsValue
          ? `The stored value (v${held.version}) STAYS in Zenith's secret store: ${listConsumers(remaining)} still read ${ref}, and deleting it would take the credential out from under ${remaining.length === 1 ? "it" : "them"} with no copy to restore. It is deleted by whichever removal takes the last reference to it.`
          : held.exists
            ? `Nothing else in this workspace references ${ref}, so the stored value (v${held.version}) is deleted from Zenith's secret store too. It cannot be recovered — Zenith keeps no copy and no backup of it.`
            : isOurs(ref)
              ? `Zenith's store holds no value for ${ref}, so only the reference goes.`
              : `${ref} lives in your own secret manager; Zenith does not touch it. Remove it there if nothing else uses it.`,
      ],
      warnings: [
        `${service.name} loses ${input.key} at the next deploy and will fail at runtime if it still reads it.`,
        `Anything already running keeps the value it was given at deploy time until it is redeployed — removing it here does not pull it out of a live container.`,
        ...(held.exists && keepsValue && remaining.every((c) => c.live)
          ? [
              `The only thing left reading ${ref} is a revision that is still deployed (${listConsumers(remaining)}). The value is kept so a rollback or a redeploy of it still works; to delete it once that revision is gone, point a variable at ${ref} with system.setSecret and remove that.`,
            ]
          : []),
      ],
      apply:
        isOurs(ref) && !keepsValue ? () => void removeStoredSecret(ctx.workspaceId, ref) : undefined,
      data: { serviceId: service.id, secretRef: ref, valueKept: keepsValue },
    };
  },
});
