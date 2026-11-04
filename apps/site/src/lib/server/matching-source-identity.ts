import { createHash } from 'node:crypto';

/** Unlike the upstream content fingerprint, this identity preserves the exact
 * source bytes on which extraction offsets and completeness depend. */
export function matchingSourceCaptureDigest(capture: unknown): string {
  return typeof capture === 'string'
    ? createHash('sha256').update(capture).digest('hex')
    : '';
}
