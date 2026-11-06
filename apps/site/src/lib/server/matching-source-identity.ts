import { createHash } from 'node:crypto';
import { MATCHING_SOURCE_EXTRACTION_VERSION } from './matching-source-extraction-contract.js';
import {
  type MatchingSourceDecisionProfile,
  matchingSourceSemanticOntologyDigest,
} from './matching-source-semantics.js';

/** Unlike the upstream content fingerprint, this identity preserves the exact
 * source bytes on which extraction offsets and completeness depend. */
export function matchingSourceCaptureDigest(capture: unknown): string {
  return typeof capture === 'string'
    ? createHash('sha256')
        .update(
          JSON.stringify([
            MATCHING_SOURCE_EXTRACTION_VERSION,
            matchingSourceSemanticOntologyDigest,
            capture,
          ]),
        )
        .digest('hex')
    : '';
}

/** Receipt identity for an explicitly selected decision preparation strategy. */
export function matchingSourceDecisionRequestId(
  profile: MatchingSourceDecisionProfile,
): string {
  const {
    provider,
    transport,
    model,
    revision,
    maxInputBytes,
    preparationVersion,
  } = profile;
  return `decision:${createHash('sha256')
    .update(
      JSON.stringify([
        provider,
        transport,
        model,
        revision,
        maxInputBytes,
        preparationVersion,
        matchingSourceSemanticOntologyDigest,
      ]),
    )
    .digest('hex')}`;
}
