"use client";
/**
 * Re-export barrel. The small pieces every screen shares now live next door:
 * the action runner in `use-run-action.ts`, the plan-first confirm dialog in
 * `action-confirm.tsx`, the role chip in `role-chip.tsx`, and the one-liner
 * presenters in `badges.tsx`. Import from those directly in new code.
 */
export { errorText, useRunAction, useSafeToasts, type Scope } from "@/components/screens/use-run-action";
export { ActionConfirm, ErrorNote, type ActionConfirmProps } from "@/components/screens/action-confirm";
export { RoleChip, roleShortfall } from "@/components/screens/role-chip";
export {
  ActorDot,
  ChangeRow,
  EnvDot,
  SectionTitle,
  SimulatedChip,
  envTone,
} from "@/components/screens/badges";
