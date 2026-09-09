/**
 * Every backend word the Apps screens have to show, and the words a builder
 * reads instead. One map per vocabulary, so a state never reads two ways on
 * two screens — and so `superseded` never reaches a person.
 *
 * Pure — no React. Workstream W9 (hosted R3)
 */
import type { ChipTone } from "@/components/ui/chip";
import type {
  AppRole,
  AppState,
  DeliveryState,
  GrantState,
  InviteState,
  ReleaseStatus,
} from "@/lib/hosted/contracts";

export interface Label {
  text: string;
  tone: ChipTone;
  /** the extra sentence a state needs before it makes sense */
  note?: string;
}

export const APP_STATE: Record<AppState, Label> = {
  active: { text: "Active", tone: "ok", note: "Invited people can open this app." },
  suspended: {
    text: "Suspended",
    tone: "warn",
    note: "Nobody can open this app. Its data, releases and audience are kept.",
  },
  recovering: {
    text: "In recovery",
    tone: "warn",
    note: "This app stays closed after a restore until an operator has checked who may open it.",
  },
  deleted: { text: "Deleted", tone: "neutral", note: "This app has been removed." },
};

export const RELEASE_STATUS: Record<ReleaseStatus, Label> = {
  candidate: { text: "Candidate", tone: "neutral" },
  verified: { text: "Verified", tone: "info" },
  active: { text: "Live", tone: "ok" },
  superseded: { text: "Replaced", tone: "neutral" },
  failed: { text: "Failed", tone: "err" },
  rolled_back: { text: "Rolled back", tone: "warn" },
};

export const GRANT_STATE: Record<GrantState, Label> = {
  active: { text: "Can open", tone: "ok" },
  revoked: { text: "Revoked", tone: "neutral" },
  needs_reapproval: {
    text: "Needs re-approval",
    tone: "warn",
    note: "A restore could not confirm this person against the revocation record. They stay locked out until an operator approves them again.",
  },
};

export const INVITE_STATE: Record<InviteState, Label> = {
  pending: { text: "Waiting to be accepted", tone: "info" },
  accepted: { text: "Accepted", tone: "ok" },
  expired: { text: "Expired", tone: "warn", note: "Invitations last 48 hours. Send a new one." },
  revoked: { text: "Revoked", tone: "neutral" },
  superseded: { text: "Replaced by a newer invitation", tone: "neutral" },
};

/**
 * `sent` is the whole point of this map: the mail server accepted the message,
 * which is not the same as it reaching a mailbox, and the UI must not say it is.
 */
export const DELIVERY_STATE: Record<DeliveryState, Label> = {
  pending: { text: "Queued to send", tone: "neutral" },
  sending: { text: "Sending", tone: "info" },
  sent: {
    text: "Email accepted by the mail server (delivery not confirmed)",
    tone: "info",
  },
  failed: { text: "Not sent", tone: "err" },
};

/** What each app role may do, for the role picker and the audience table. */
export const APP_ROLE_TEXT: Record<AppRole, string> = {
  owner: "Opens the app, publishes new versions and manages who can open it",
  editor: "Opens the app and changes its data",
  viewer: "Opens the app and reads its data",
};

export const APP_ROLE_OPTIONS = (["owner", "editor", "viewer"] as const).map((role) => ({
  value: role,
  label: `${role} — ${APP_ROLE_TEXT[role].toLowerCase()}`,
}));

/**
 * Probe ids the release workstream names, in words. An id this map does not
 * know is spaced and capitalised rather than shown as `data_round_trip`.
 */
export const HEALTH_CHECK_TITLE: Record<string, string> = {
  authority_row: "The app's record exists",
  active_release: "A release is serving",
  artifact_verified: "The files being served match what was built",
  data_quick_check: "The app's data can be opened and read",
  schema_version: "The stored data matches this version of the app",
  records: "Stored records",
  index_fetch: "The app's first page loads",
  session_endpoint: "The sign-in check answers",
  data_round_trip: "Data can be written and read back",
  schema_compat: "The stored data still matches the app",
};

export const checkTitle = (id: string): string =>
  HEALTH_CHECK_TITLE[id] ?? id.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** "No email transport is configured" is a fact about this install, not an error. */
export const TRANSPORT_NOTE: Record<string, string> = {
  none: "No email is configured on this install, so nothing was sent. Copy the invitation link and pass it on yourself.",
  log: "Email is set to log-only on this install, so the message was written to the server log instead of being sent. Copy the invitation link and pass it on yourself.",
  smtp: "Handed to the mail server configured for this install.",
};
