/**
 * The status of an operation as a badge: an icon, a plain-language label and a
 * sentence on hover. Colour is never the only carrier of meaning (the label and
 * icon always render). `succeeded` is deliberately not styled as "verified":
 * a finished run is a claim about the control plane's own bookkeeping, and the
 * sentence says the result is confirmed by the next observation.
 */
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CircleX,
  Clock,
  Hourglass,
  Loader,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { OperationStatus } from "@/lib/controlplane/types";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { OPERATION_STATUS_LABEL, OPERATION_STATUS_SENTENCE } from "./labels";

const PRESENTATION: Record<OperationStatus, { tone: ChipTone; Icon: LucideIcon }> = {
  proposed: { tone: "neutral", Icon: CircleDashed },
  awaiting_approval: { tone: "warn", Icon: Hourglass },
  approved: { tone: "info", Icon: ShieldCheck },
  rejected: { tone: "neutral", Icon: XCircle },
  denied: { tone: "err", Icon: ShieldAlert },
  queued: { tone: "info", Icon: Clock },
  running: { tone: "signal", Icon: Loader },
  succeeded: { tone: "ok", Icon: CheckCircle2 },
  failed: { tone: "err", Icon: CircleX },
  uncertain: { tone: "warn", Icon: CircleHelp },
  cancelled: { tone: "neutral", Icon: Ban },
  expired: { tone: "neutral", Icon: Clock },
};

export interface OperationStatusBadgeProps {
  status: OperationStatus;
  /** also print the status sentence next to the badge (for places with room) */
  explain?: boolean;
  className?: string;
}

export function OperationStatusBadge({ status, explain = false, className }: OperationStatusBadgeProps) {
  const { tone, Icon } = PRESENTATION[status];
  const sentence = OPERATION_STATUS_SENTENCE[status];
  const badge = (
    <Chip
      tone={tone}
      title={sentence}
      className={className}
      icon={<Icon className="h-3 w-3" aria-hidden="true" />}
    >
      {OPERATION_STATUS_LABEL[status]}
    </Chip>
  );
  if (!explain) return badge;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {badge}
      <span className="text-[12.5px] text-ink-mute">{sentence}</span>
    </span>
  );
}
