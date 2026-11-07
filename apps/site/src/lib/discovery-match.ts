export type DiscoveryMatchStatus = 'qualified' | 'screened-with-gaps';

export type DiscoveryEvidenceItem = {
  message: string;
  excerpts?: string[];
};

export type DiscoveryEvidenceExplanation = {
  supported: DiscoveryEvidenceItem[];
  gaps: DiscoveryEvidenceItem[];
  highlight?: string;
  applicationSteps?: DiscoveryEvidenceItem[];
  interpretation?: string;
};

export const DISCOVERY_EVIDENCE_GAPS_LABEL = 'Screened · evidence gaps';

export function discoveryEvidenceGaps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((reason): reason is string => typeof reason === 'string')
    : [];
}

export function discoveryMatchHighlight(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('highlight' in value))
    return;
  const { highlight } = value;
  if (
    typeof highlight === 'string' &&
    highlight.trim() &&
    highlight.length <= 200
  )
    return highlight;
}
