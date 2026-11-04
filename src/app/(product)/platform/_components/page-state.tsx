/** Fixed, safe error/empty text; cloud and log strings are never HTML. */
import { Callout } from "@/components/ui/callout";
export function PageState({ error, missing }: { error: string; missing?: boolean }) {
  return <Callout tone={missing ? "info" : "err"} title={missing ? "Not available" : "Could not load platform"}>{error}</Callout>;
}
export function EvidenceNote() {
  return <p className="mb-5 text-[12px] text-ink-mute">Evidence: contract. These views have not been verified against a live cloud. Stored observations may be stale; their recorded times are shown.</p>;
}
