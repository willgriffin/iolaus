import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { normalizeSourceCrawlItemOptions } from './source-crawl-item-slug';

@smrt({
  tableName: 'source_crawl_items',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class SourceCrawlItem extends SmrtObject {
  constructor(options: SmrtObjectOptions = {}) {
    super(normalizeSourceCrawlItemOptions(options));
  }

  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  attemptKey = '';
  @field({ type: 'text' })
  outcome = 'pending';
  @field({ type: 'datetime', nullable: true })
  terminalAt: Date | null = null;
  // Opportunity ids are UUID-shaped but deployed SMRT databases retain the
  // legacy text primary-key type. The guarded migration owns the compatible
  // physical reference and its explicit legacy repair lifecycle.
  @field({ type: 'text', nullable: true })
  opportunityId: string | null = null;
  @field({ type: 'text' })
  duplicateOfSourceCrawlItemId = '';
  @field({ type: 'text' })
  reconciliationStatus = 'unmatched';
  @field({ type: 'text' })
  reconciliationKey = '';
  @field({ type: 'text' })
  matchStrategy = 'none';
  @field({ type: 'decimal', nullable: true })
  matchConfidence: number | null = null;
  @field({ type: 'text' })
  reconciliationNotes = '';
  @field({ type: 'text' })
  externalId = '';
  @field({ type: 'text' })
  postingUrl = '';
  @field({ type: 'text' })
  canonicalUrl = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  companyName = '';
  @field({ type: 'text' })
  status = 'seen';
  @field({ type: 'text' })
  contentFingerprint = '';
  @field({ type: 'integer' })
  contentVersion = 0;
  @field({ type: 'text' })
  intelligenceEnqueueStatus = 'ineligible';
  @field({ type: 'text' })
  intelligenceJobId = '';
  @field({ type: 'text' })
  reason = '';
  @field({ type: 'text' })
  rawJson = '{}';
}
