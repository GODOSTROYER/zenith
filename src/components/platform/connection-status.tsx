/**
 * The connection state of a runner or machine as a badge: icon, plain label and
 * a sentence. Colour is never the only carrier of meaning.
 */
import { Ban, CheckCircle2, RefreshCw, WifiOff, type LucideIcon } from "lucide-react";
import { Chip, type ChipTone } from "@/components/ui/chip";
import type { ConnectionState } from "@/lib/runners/lifecycle";

const PRESENTATION: Record<ConnectionState, { tone: ChipTone; Icon: LucideIcon; label: string }> = {
  online: { tone: "ok", Icon: CheckCircle2, label: "Online" },
  recovering: { tone: "info", Icon: RefreshCw, label: "Reconnected, catching up" },
  offline: { tone: "warn", Icon: WifiOff, label: "Offline" },
  revoked: { tone: "neutral", Icon: Ban, label: "Revoked" },
};

export function ConnectionStatusBadge({ state, title }: { state: ConnectionState; title?: string }) {
  const { tone, Icon, label } = PRESENTATION[state];
  return (
    <Chip tone={tone} title={title} icon={<Icon className="h-3 w-3" aria-hidden="true" />}>
      {label}
    </Chip>
  );
}
