export type DiscoveryMatchStatus = 'qualified' | 'screened-with-gaps';

export const DISCOVERY_EVIDENCE_GAPS_LABEL = 'Screened · evidence gaps';

export function discoveryEvidenceGaps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((reason): reason is string => typeof reason === 'string')
    : [];
}
