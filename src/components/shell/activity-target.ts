/**
 * Where one notification leads — decided per notification, never per panel.
 *
 * The Activity panel used to derive a single URL from "the project in the URL,
 * or else the workspace's first one" and put it on every row, so a notification
 * about project A opened project B's trail. A notification is about exactly one
 * project or about none, and the only honest answers are that project's trail,
 * a plain row, or "no longer available".
 *
 * Deliberately free of React and of storage so both the routing and the
 * loading of old records can be tested as the pure functions they are.
 */
import type { ToastKind, ToastRecord } from "@/components/ui/toast";

/** A project the caller is authorized for — the bootstrap's own rows. */
export interface AuthorizedProject {
  id: string;
  name: string;
  slug: string;
}

export type ActivityTarget =
  /** the trail of the project this notification is about */
  | { kind: "link"; href: string; projectName: string }
  /**
   * Not about a project (or an old record saved before notifications carried
   * one): a plain row, with nothing claimed either way.
   */
  | { kind: "none" }
  /** the workspace list has not arrived yet — plain for now, never a guess */
  | { kind: "pending" }
  /** the project is deleted, or not one this caller may open */
  | { kind: "unavailable" };

/** Said out loud on rows whose project is gone; also their accessible wording. */
export const UNAVAILABLE_NOTE = "Activity trail no longer available";

/**
 * The trail for one notification.
 *
 * `projectId` is authoritative: when a record carries one and no authorized
 * project has it, the target is gone — even if some other project now answers
 * to the same slug. A slug is only consulted when the record has no id at all.
 */
export function activityTarget(
  record: Pick<ToastRecord, "projectId" | "projectSlug">,
  projects: readonly AuthorizedProject[] | undefined
): ActivityTarget {
  const id = record.projectId?.trim();
  const slug = record.projectSlug?.trim();
  if (!id && !slug) return { kind: "none" };
  // Bootstrap in flight: this caller's projects are not known yet, and a row
  // must not be declared dead by a list that has not loaded.
  if (!projects) return { kind: "pending" };

  const match = id
    ? projects.find((p) => p.id === id)
    : projects.find((p) => p.slug === slug);
  if (!match) return { kind: "unavailable" };
  return {
    kind: "link",
    href: `/p/${encodeURIComponent(match.slug)}/activity`,
    projectName: match.name,
  };
}

const KINDS: ToastKind[] = ["ok", "warn", "err", "info"];

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Turn whatever is in session storage into records this panel can render.
 *
 * The buffer outlives a deploy, so it holds records written by older builds —
 * without project identity, and in the limit with fields this build never
 * wrote. Anything unreadable is dropped rather than rendered half-way, and a
 * record that predates project identity simply comes back without it.
 */
export function normalizeActivity(raw: unknown, keep: number): ToastRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: ToastRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = str(row.id);
    const title = str(row.title);
    const ts = str(row.ts);
    if (!id || !title || !ts) continue;
    const kind = KINDS.find((k) => k === row.kind) ?? "info";
    out.push({
      id,
      title,
      ts,
      kind,
      ...(str(row.body) ? { body: str(row.body) } : {}),
      ...(str(row.projectId) ? { projectId: str(row.projectId) } : {}),
      ...(str(row.projectSlug) ? { projectSlug: str(row.projectSlug) } : {}),
    });
    if (out.length >= keep) break;
  }
  return out;
}
