"use client";
/** The role an action demands, and the sentence for not having it. */
import type { Role } from "@/lib/actions/core";
import { roleShortfall } from "@/lib/domain/roles";
import { Chip } from "@/components/ui/chip";

/**
 * The shared shortfall sentence, re-exported here so screen modules keep one
 * import for everything this file gives them.
 */
export { roleShortfall };

/**
 * "needs editor" — the role an action demands, toned red when the caller does
 * not have it. Both plan previews (the confirm dialog and the inspector's
 * inline PlanFirst) show the same chip with the same tooltip.
 */
export function RoleChip({ required, shortfall }: { required: Role; shortfall?: string }) {
  return (
    <Chip
      tone={shortfall ? "err" : "neutral"}
      title={shortfall ?? `Running this needs the ${required} role.`}
    >
      needs {required}
    </Chip>
  );
}
