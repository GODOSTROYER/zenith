/**
 * Small labels that carry meaning. Every one is text first: colour is the
 * second signal, never the only one.
 *
 * Workstream W4 (hosted R3)
 */
import type { RequestPriority, RequestStatus, SessionRole } from "../api";
import { priorityLabel, statusLabel } from "../state";

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`badge status-${status}`}>{statusLabel(status)}</span>;
}

export function PriorityBadge({ priority }: { priority: RequestPriority }) {
  if (priority === "normal") return null;
  return (
    <span className={`badge priority-${priority}`}>{priorityLabel(priority)} priority</span>
  );
}

const ROLE_EXPLAINS: Record<SessionRole, string> = {
  owner: "You can create, edit and manage this app.",
  editor: "You can create and edit requests.",
  viewer: "You can read every request. Changing them is not part of your access.",
};

export function RoleBadge({ role }: { role: SessionRole }) {
  return (
    <span className={`badge role-${role}`} title={ROLE_EXPLAINS[role]}>
      {role}
    </span>
  );
}
