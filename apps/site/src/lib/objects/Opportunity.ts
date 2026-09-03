import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import type { OpportunityIntelligenceJobArgs } from '../server/opportunity-intelligence-job.js';

@smrt({
  tableName: 'opportunities',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Opportunity extends SmrtObject {
  @field({ type: 'text' })
  organizationProfileId = '';
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  locationNotes = '';
  @field({ type: 'text' })
  externalId = '';
  @field({ type: 'text' })
  postingUrl = '';
  @field({ type: 'text' })
  canonicalUrl = '';
  @field({ type: 'text' })
  applyMethod = 'unknown';
  @field({ type: 'text' })
  applyUrl = '';
  @field({ type: 'text' })
  applyInstructions = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  employmentType = 'unknown';
  @field({ type: 'text' })
  seniority = 'unknown';
  @field({ type: 'text' })
  workMode = 'unknown';
  @field({ type: 'text' })
  locations = '';
  @field({ type: 'boolean' })
  relocationSupported = false;
  @field({ type: 'boolean' })
  visaOrEorPossible = false;
  @field({ type: 'decimal', nullable: true })
  salaryMin: number | null = null;
  @field({ type: 'decimal', nullable: true })
  salaryMax: number | null = null;
  @field({ type: 'text' })
  currency = '';
  @field({ type: 'decimal', nullable: true })
  hourlyMin: number | null = null;
  @field({ type: 'decimal', nullable: true })
  hourlyMax: number | null = null;
  @field({ type: 'decimal', nullable: true })
  equityMinPercent: number | null = null;
  @field({ type: 'decimal', nullable: true })
  equityMaxPercent: number | null = null;
  @field({ type: 'text' })
  compNotes = '';
  @field({ type: 'text' })
  descriptionRaw = '';
  @field({ type: 'text' })
  sourceContentFingerprint = '';
  @field({ type: 'integer' })
  sourceContentVersion = 0;
  @field({ type: 'text' })
  sourceContentJson = '{}';
  @field({ type: 'text' })
  preparedPostingVersion = '';
  @field({ type: 'text' })
  preparedPostingFingerprint = '';
  @field({ type: 'text' })
  preparedPostingJson = '{}';
  @field({ type: 'text' })
  sourceIntelligenceStatus = 'ineligible';
  @field({ type: 'text' })
  sourceIntelligenceJobId = '';
  @field({ type: 'text' })
  descriptionSummary = '';
  @field({ type: 'text' })
  requiredSkills = '';
  @field({ type: 'text' })
  preferredSkills = '';
  @field({ type: 'text' })
  responsibilities = '';
  @field({ type: 'text' })
  qualifications = '';
  @field({ type: 'text' })
  domainTags = '';
  @field({ type: 'text' })
  roleTags = '';
  @field({ type: 'boolean' })
  greenfieldSignal = false;
  @field({ type: 'boolean' })
  founderSignal = false;
  @field({ type: 'text' })
  status = 'found';
  @field({ type: 'text' })
  freshness = 'unknown';
  @field({ type: 'integer', nullable: true })
  humanRating: number | null = null;
  @field({ type: 'text' })
  humanReviewStatus = 'needs_input';
  @field({ type: 'text' })
  humanReviewNotes = '';
  @field({ type: 'text' })
  reviewedByUserId = '';
  @field({ type: 'text' })
  reviewedByProfileId = '';
  @field({ type: 'datetime', nullable: true })
  reviewedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  firstSeenAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  lastSeenAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  postedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  expiresAt: Date | null = null;
  /**
   * Consecutive successful crawls of this opportunity's source that did not
   * list this posting. Reset to zero whenever the board lists it again.
   */
  @field({ type: 'integer' })
  missedCrawls = 0;
  @field({ type: 'datetime', nullable: true })
  lastMissedAt: Date | null = null;
  /**
   * Why this posting was archived without an owner decision. Empty for
   * postings archived by a human or still live.
   */
  @field({ type: 'text' })
  archiveReason = '';

  async loadFromId(id?: string) {
    if (id) this.id = id;
    return await super.loadFromId();
  }

  async processIntelligence(
    args: OpportunityIntelligenceJobArgs = {},
    context?: JobExecutionContext,
  ) {
    const { runOpportunityIntelligenceJob } = await import(
      '../server/opportunity-intelligence-job.js'
    );
    return await runOpportunityIntelligenceJob(this, args, context);
  }
}
