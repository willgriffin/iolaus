import { opportunityEligibilityProjection } from '../opportunity-eligibility.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';

export const eligibilityRefreshSelectSql = `SELECT id, source_content_json, source_content_fingerprint, source_content_version,
  posting_eligibility_json, eligibility_flags, eligibility_source_fingerprint, eligibility_source_version
  FROM opportunities WHERE CAST(id AS TEXT) > ? ORDER BY CAST(id AS TEXT) LIMIT ?`;
export const eligibilityRefreshUpdateSql = `UPDATE opportunities SET posting_eligibility_json = ?, eligibility_flags = ?,
  eligibility_source_fingerprint = ?, eligibility_source_version = ?
  WHERE id = ? AND (source_content_fingerprint = ? OR (source_content_fingerprint IS NULL AND CAST(? AS TEXT) IS NULL))
  AND (source_content_version = ? OR (source_content_version IS NULL AND CAST(? AS INTEGER) IS NULL))
  AND (source_content_json = ? OR (source_content_json IS NULL AND CAST(? AS TEXT) IS NULL)) RETURNING id`;

/** A source payload cannot vouch for its own fingerprint. Recompute using the source contract. */
export function verifiedOpportunityEligibilityProjection(
  record: Record<string, unknown>,
) {
  const source = parseOpportunitySourceContent(record.sourceContentJson);
  if (
    !source ||
    fingerprintOpportunitySourceContent(source) !==
      record.sourceContentFingerprint
  ) {
    return {
      postingEligibilityJson: '{}',
      eligibilityFlags: 32,
      eligibilitySourceFingerprint: '',
      eligibilitySourceVersion: 0,
    };
  }
  return opportunityEligibilityProjection(record);
}
