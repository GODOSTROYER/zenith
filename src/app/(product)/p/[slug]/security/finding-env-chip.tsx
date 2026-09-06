/**
 * The environment a finding is about, shown on every list that carries one.
 * Toned only when it is the environment selected in the header — otherwise the
 * chip would imply the finding belongs to what you are looking at.
 */
import type { Environment, SecurityFinding } from "@/lib/domain/types";
import { Chip } from "@/components/ui/chip";
import { EnvDot, envTone } from "@/components/screens/shared";

export interface FindingEnvChipProps {
  finding: SecurityFinding;
  envById: Map<string, Environment>;
  selectedEnvId: string | undefined;
}

export function FindingEnvChip({ finding, envById, selectedEnvId }: FindingEnvChipProps) {
  if (!finding.environmentId) return null;
  const e = envById.get(finding.environmentId);
  const klass = e?.class ?? "sandbox";
  const here = finding.environmentId === selectedEnvId;
  return (
    <Chip
      tone={here ? envTone(klass) : "neutral"}
      icon={<EnvDot klass={klass} />}
      title={
        here
          ? "This finding is about the environment selected in the header."
          : `This finding is about ${e?.name ?? finding.environmentId}, not the environment selected in the header.`
      }
    >
      {e?.name ?? finding.environmentId}
    </Chip>
  );
}
