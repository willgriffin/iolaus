import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** Immutable, allowlisted snapshot and its staged private PDF metadata. */
@smrt({
  tableName: 'public_profile_revisions',
  conflictColumns: ['publication_id', 'revision_id'],
  indexes: [
    {
      name: 'public_profile_revisions_publication_lookup',
      columns: ['publicationId', 'created_at'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
export class PublicProfileRevision extends SmrtObject {
  @field({ type: 'text', required: true }) publicationId = '';
  @field({ type: 'text', required: true }) revisionId = '';
  @field({ type: 'integer' }) baseRevision = 0;
  @field({ type: 'json', required: true, sensitive: true }) snapshot: unknown =
    {};
  @field({ type: 'text', required: true, sensitive: true }) pdfPath = '';
  @field({ type: 'text', required: true, sensitive: true }) pdfSha256 = '';
  @field({ type: 'integer' }) pdfBytes = 0;
  @field({ type: 'text', required: true, sensitive: true }) sourceProfileId =
    '';
  @field({ type: 'text' }) status = 'prepared';
  @field({ type: 'integer', nullable: true }) publishedRevision: number | null =
    null;
}
