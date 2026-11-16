/**
 * Loads the hand-written `tofu show -json`-shaped fixtures as `NormalizedPlan`
 * values, checking their shape first so a fixture cannot drift from the
 * contract in `src/lib/tofu/types.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { NormalizedPlan } from "@/lib/tofu/types";

const action = z.enum(["create", "update", "delete", "replace", "read", "no-op"]);

const NormalizedPlanShape = z
  .object({
    tofuVersion: z.string(),
    formatVersion: z.string(),
    configDigest: z.string().regex(/^[0-9a-f]{64}$/),
    lockDigest: z.string().regex(/^[0-9a-f]{64}$/),
    planDigest: z.string().regex(/^[0-9a-f]{64}$/),
    resourceChanges: z.array(
      z
        .object({
          address: z.string().min(1),
          nodeAddress: z.string().optional(),
          type: z.string().min(1),
          providerName: z.string(),
          action,
          changes: z.array(
            z
              .object({
                path: z.string().min(1),
                before: z.unknown(),
                after: z.unknown(),
                sensitive: z.boolean(),
                forcesReplacement: z.boolean(),
              })
              .strict()
          ),
          destroysData: z.boolean(),
        })
        .strict()
    ),
    outputChanges: z.array(z.object({ name: z.string(), action, sensitive: z.boolean() }).strict()),
    summary: z.object({ create: z.number(), update: z.number(), delete: z.number(), replace: z.number(), noop: z.number() }).strict(),
    empty: z.boolean(),
    diagnostics: z.array(z.unknown()),
    createdAt: z.string(),
  })
  .strict();

export function loadPlanFixture(name: string): NormalizedPlan {
  const file = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return NormalizedPlanShape.parse(JSON.parse(readFileSync(file, "utf8"))) as NormalizedPlan;
}
