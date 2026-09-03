import {
  ProfileCollection,
  ProfileRelationshipCollection,
  ProfileRelationshipTypeCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { TagCollection } from '@happyvertical/smrt-tags';
import { getSmrtOptions } from '../src/lib/server/db.js';
import { getCollection } from '../src/lib/server/smrt.js';

type RecordLike = Record<string, unknown> & {
  id?: string;
  save?: () => Promise<void>;
};
type TagRecord = RecordLike & { name?: string };
type TagCache = Map<string, Promise<TagRecord | null>>;

type ListableCollection = {
  list: (options: { limit: number; offset?: number; where?: Record<string, unknown> }) => Promise<unknown[]>;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function splitList(value: unknown): string[] {
  return stringValue(value)
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendLines(...values: string[]): string {
  return values.filter(Boolean).join('\n');
}

function hostnameFromUrl(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) return '';

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[/?#]/)[0]
      .toLowerCase();
  }
}

async function saveRecord(record: RecordLike, description: string): Promise<void> {
  if (typeof record.save !== 'function') {
    throw new Error(`Cannot persist ${description}: record does not expose save().`);
  }
  await record.save();
}

async function listAll(collection: ListableCollection, pageSize = 500): Promise<RecordLike[]> {
  const records: RecordLike[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = (await collection.list({ limit: pageSize, offset })) as RecordLike[];
    records.push(...page);
    if (page.length < pageSize) break;
  }

  return records;
}

function mergeTextField(record: RecordLike, key: string, value: unknown): boolean {
  const existing = stringValue(record[key]);
  const next = stringValue(value);
  if (!next || existing) return false;

  record[key] = next;
  return true;
}

async function getProfileType(options: { description: string; name: string; slug: string }) {
  const profileTypes = await ProfileTypeCollection.create(getSmrtOptions());
  return await profileTypes.getOrCreateBySlug(options.slug, {
    description: options.description,
    name: options.name,
  });
}

function profileDescription(...parts: string[]): string {
  return appendLines(...parts);
}

async function getOrCreateProfile(options: {
  description?: string;
  email?: string;
  name: string;
  profileTypeId: string;
}) {
  const profiles = await ProfileCollection.create(getSmrtOptions());
  const email = options.email?.trim().toLowerCase();

  if (email) {
    const existingByEmail = await profiles.findByEmail(email);
    if (existingByEmail) return existingByEmail;
  }

  const existing = await profiles.list({
    limit: 1,
    where: { name: options.name, typeId: options.profileTypeId },
  });
  if (existing[0]) return existing[0];

  const profile = await profiles.create({
    description: options.description,
    email,
    name: options.name,
    typeId: options.profileTypeId,
  });
  await profile.save();
  return profile;
}

async function mergeProfileDescription(profile: RecordLike, description: string, descriptionLabel: string) {
  const next = stringValue(description);
  if (!next) return;

  const existing = stringValue(profile.description);
  if (existing.includes(next)) return;

  profile.description = appendLines(existing, next);
  await saveRecord(profile, descriptionLabel);
}

const actorProfileCache = new Map<string, string>();

async function getOrCreateActorProfile(value: unknown): Promise<string> {
  const name = stringValue(value);
  if (!name) return '';

  const cacheKey = name.toLowerCase();
  const cached = actorProfileCache.get(cacheKey);
  if (cached) return cached;

  const isAgent =
    cacheKey.includes('agent') || cacheKey.includes('automation') || cacheKey.includes('bot');
  const profileType = await getProfileType(
    isAgent
      ? {
          description: 'Agent or automation identity.',
          name: 'Agent',
          slug: 'agent',
        }
      : {
          description: 'Human profile.',
          name: 'Person',
          slug: 'person',
        },
  );
  if (!profileType.id) return '';

  const profileName = cacheKey === 'will' ? 'Example Candidate' : name;
  const profile = await getOrCreateProfile({
    description: isAgent ? 'Employment-search automation actor.' : undefined,
    name: profileName,
    profileTypeId: profileType.id as string,
  });
  const profileId = stringValue(profile.id);
  if (profileId) actorProfileCache.set(cacheKey, profileId);
  return profileId;
}

async function createCompanyResearch(legacyCompany: RecordLike, organizationProfileId: string) {
  const researchCollection = await getCollection('CompanyResearch');
  const existing = await researchCollection.list({
    limit: 1,
    where: { organizationProfileId },
  });
  if (existing[0]) {
    const research = existing[0] as RecordLike;
    let changed = false;

    changed = mergeTextField(research, 'careersUrl', legacyCompany.careersUrl) || changed;
    changed = mergeTextField(research, 'concerns', legacyCompany.concerns) || changed;
    changed = mergeTextField(research, 'crunchbaseUrl', legacyCompany.crunchbaseUrl) || changed;
    changed = mergeTextField(research, 'fundingNotes', legacyCompany.fundingNotes) || changed;
    changed = mergeTextField(research, 'legacyHqLocation', legacyCompany.hqLocation) || changed;
    changed = mergeTextField(research, 'legacyIndustryTags', legacyCompany.industryTags) || changed;
    changed = mergeTextField(research, 'linkedinUrl', legacyCompany.linkedinUrl) || changed;
    changed = mergeTextField(research, 'productSummary', legacyCompany.productSummary) || changed;
    changed = mergeTextField(research, 'researchFolderPath', legacyCompany.researchFolderPath) || changed;
    changed = mergeTextField(research, 'technicalSummary', legacyCompany.technicalSummary) || changed;
    changed = mergeTextField(research, 'timezoneNotes', legacyCompany.timezoneNotes) || changed;
    changed = mergeTextField(research, 'websiteUrl', legacyCompany.websiteUrl) || changed;
    changed = mergeTextField(research, 'whyInteresting', legacyCompany.whyInteresting) || changed;
    changed = mergeTextField(research, 'ycUrl', legacyCompany.ycUrl) || changed;

    if (changed) await saveRecord(research, `company research ${stringValue(research.id)}`);
    return research;
  }

  const research = await researchCollection.create({
    careersUrl: stringValue(legacyCompany.careersUrl),
    concerns: stringValue(legacyCompany.concerns),
    crunchbaseUrl: stringValue(legacyCompany.crunchbaseUrl),
    fundingNotes: stringValue(legacyCompany.fundingNotes),
    legacyHqLocation: stringValue(legacyCompany.hqLocation),
    legacyIndustryTags: stringValue(legacyCompany.industryTags),
    linkedinUrl: stringValue(legacyCompany.linkedinUrl),
    organizationProfileId,
    productSummary: stringValue(legacyCompany.productSummary),
    remotePolicy: stringValue(legacyCompany.remotePolicy) || 'unknown',
    researchFolderPath: stringValue(legacyCompany.researchFolderPath),
    researchStatus: stringValue(legacyCompany.researchStatus) || 'needed',
    stage: stringValue(legacyCompany.stage) || 'unknown',
    technicalSummary: stringValue(legacyCompany.technicalSummary),
    timezoneNotes: stringValue(legacyCompany.timezoneNotes),
    websiteUrl: stringValue(legacyCompany.websiteUrl),
    whyInteresting: stringValue(legacyCompany.whyInteresting),
    ycUrl: stringValue(legacyCompany.ycUrl),
  });
  await research.save();
  return research;
}

function legacyCompanyProfileName(company: RecordLike, duplicateNames: Set<string>): string {
  const name = stringValue(company.name);
  if (!duplicateNames.has(name.toLowerCase())) return name;

  const hostname = hostnameFromUrl(company.websiteUrl);
  if (hostname) return `${name} (${hostname})`;

  return `${name} (${stringValue(company.id)})`;
}

async function backfillCompanies() {
  const organizationType = await getProfileType({
    description: 'Company or organization profile.',
    name: 'Organization',
    slug: 'organization',
  });
  const companies = await getCollection('Company');
  const records = await listAll(companies as ListableCollection);
  const companyMap = new Map<string, string>();
  const nameCounts = new Map<string, number>();

  for (const company of records) {
    const name = stringValue(company.name).toLowerCase();
    if (!name) continue;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const duplicateNames = new Set(
    [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );

  for (const company of records) {
    const name = stringValue(company.name);
    if (!name || !company.id || !organizationType.id) continue;

    const profile = await getOrCreateProfile({
      description: stringValue(company.productSummary) || stringValue(company.whyInteresting),
      name: legacyCompanyProfileName(company, duplicateNames),
      profileTypeId: organizationType.id as string,
    });
    if (!profile.id) continue;

    companyMap.set(company.id, profile.id as string);
    await createCompanyResearch(company, profile.id as string);
  }

  return companyMap;
}

function relationshipSlugForPerson(person: RecordLike): string {
  const role = stringValue(person.roleTitle).toLowerCase();
  if (role.includes('founder')) return 'founder_of';
  if (role.includes('recruit')) return 'recruiter_for';
  if (role.includes('hiring')) return 'hiring_manager_at';
  return 'works_at';
}

async function backfillPeople(companyMap: Map<string, string>) {
  const options = getSmrtOptions();
  const profileTypes = await ProfileTypeCollection.create(options);
  const relationshipTypes = await ProfileRelationshipTypeCollection.create(options);
  const relationships = await ProfileRelationshipCollection.create(options);
  const personType = await profileTypes.getOrCreateBySlug('person', {
    description: 'Human profile.',
    name: 'Person',
  });
  const people = await getCollection('EmploymentPerson');
  const records = await listAll(people as ListableCollection);
  let migratedCount = 0;

  for (const person of records) {
    const name = stringValue(person.name);
    if (!name || !personType.id) continue;
    const personDescription = profileDescription(
      stringValue(person.notes) || stringValue(person.roleTitle),
      stringValue(person.linkedinUrl) ? `LinkedIn: ${stringValue(person.linkedinUrl)}` : '',
      stringValue(person.githubUrl) ? `GitHub: ${stringValue(person.githubUrl)}` : '',
      stringValue(person.websiteUrl) ? `Website: ${stringValue(person.websiteUrl)}` : '',
    );

    const profile = await getOrCreateProfile({
      description: personDescription,
      email: stringValue(person.email),
      name,
      profileTypeId: personType.id as string,
    });
    await mergeProfileDescription(
      profile,
      personDescription,
      `profile ${stringValue(profile.id)}`,
    );

    const organizationProfileId = companyMap.get(stringValue(person.companyId));
    if (!profile.id || !organizationProfileId) continue;

    const relationshipType = await relationshipTypes.getOrCreateBySlug(relationshipSlugForPerson(person), {
      name: relationshipSlugForPerson(person)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
      reciprocal: false,
    });
    if (!relationshipType.id) continue;

    const existing = await relationships.list({
      limit: 1,
      where: {
        fromProfileId: profile.id,
        toProfileId: organizationProfileId,
        typeId: relationshipType.id,
      },
    });
    if (existing[0]) continue;

    const relationship = await relationships.create({
      fromProfileId: profile.id,
      toProfileId: organizationProfileId,
      typeId: relationshipType.id,
    });
    await relationship.save();
    migratedCount += 1;
  }

  return migratedCount;
}

async function getOrCreateTag(
  tags: TagCollection,
  tagCache: TagCache,
  value: string,
  context: string,
) {
  const slug = slugify(value);
  if (!slug) return null;

  const cacheKey = `${context}:${slug}`;
  const cached = tagCache.get(cacheKey);
  if (cached) return cached;

  const tagPromise = (async () => {
    const tag = (await tags.getOrCreate(slug, context)) as TagRecord;
    if (tag.name !== value.trim()) {
      tag.name = value.trim();
      await saveRecord(tag, `tag ${context}:${slug}`);
    }
    return tag;
  })();

  tagCache.set(cacheKey, tagPromise);
  return tagPromise;
}

async function createOpportunityTag(
  tags: TagCollection,
  tagCache: TagCache,
  opportunityId: string,
  value: string,
  context: string,
  tagRole: string,
) {
  const tag = await getOrCreateTag(tags, tagCache, value, context);
  if (!tag?.id) return;

  const opportunityTags = await getCollection('OpportunityTag');
  const existing = await opportunityTags.list({
    limit: 1,
    where: { opportunityId, tagId: tag.id, tagRole },
  });
  if (existing[0]) return;

  const link = await opportunityTags.create({ opportunityId, tagId: tag.id, tagRole });
  await link.save();
}

async function backfillOpportunities(
  companyMap: Map<string, string>,
  tags: TagCollection,
  tagCache: TagCache,
) {
  const opportunities = await getCollection('Opportunity');
  const records = await listAll(opportunities as ListableCollection);
  let migratedCount = 0;

  for (const opportunity of records) {
    const opportunityId = stringValue(opportunity.id);
    if (!opportunityId) continue;
    let changed = false;

    const organizationProfileId = companyMap.get(stringValue(opportunity.companyId));
    if (organizationProfileId && !stringValue(opportunity.organizationProfileId)) {
      opportunity.organizationProfileId = organizationProfileId;
      changed = true;
    }

    const legacyLocations = stringValue(opportunity.locations);
    if (legacyLocations && !stringValue(opportunity.locationNotes)) {
      opportunity.locationNotes = legacyLocations;
      changed = true;
    }

    if (changed) await saveRecord(opportunity, `opportunity ${opportunityId}`);
    migratedCount += 1;

    for (const skill of splitList(opportunity.requiredSkills)) {
      await createOpportunityTag(tags, tagCache, opportunityId, skill, 'skill', 'required_skill');
    }
    for (const skill of splitList(opportunity.preferredSkills)) {
      await createOpportunityTag(tags, tagCache, opportunityId, skill, 'skill', 'preferred_skill');
    }
    for (const domain of splitList(opportunity.domainTags)) {
      await createOpportunityTag(tags, tagCache, opportunityId, domain, 'domain', 'domain');
    }
    for (const role of splitList(opportunity.roleTags)) {
      await createOpportunityTag(tags, tagCache, opportunityId, role, 'role', 'role');
    }
  }

  return migratedCount;
}

async function backfillSources() {
  const sources = await getCollection('Source');
  const records = await listAll(sources as ListableCollection);
  let migratedCount = 0;

  for (const source of records) {
    if (stringValue(source.ownerProfileId)) continue;

    const ownerProfileId = await getOrCreateActorProfile(source.owner);
    if (!ownerProfileId) continue;

    source.ownerProfileId = ownerProfileId;
    await saveRecord(source, `source ${stringValue(source.id)}`);
    migratedCount += 1;
  }

  return migratedCount;
}

async function backfillTasks(companyMap: Map<string, string>) {
  const tasks = await getCollection('Task');
  const records = await listAll(tasks as ListableCollection);
  let migratedCount = 0;

  for (const task of records) {
    let changed = false;
    const organizationProfileId = companyMap.get(stringValue(task.companyId));
    if (organizationProfileId && !stringValue(task.organizationProfileId)) {
      task.organizationProfileId = organizationProfileId;
      changed = true;
    }

    const createdByProfileId = await getOrCreateActorProfile(task.createdBy);
    if (createdByProfileId && !stringValue(task.createdByProfileId)) {
      task.createdByProfileId = createdByProfileId;
      changed = true;
    }

    if (!changed) continue;
    await saveRecord(task, `task ${stringValue(task.id)}`);
    migratedCount += 1;
  }

  return migratedCount;
}

async function createDecisionTag(
  tags: TagCollection,
  tagCache: TagCache,
  decisionId: string,
  value: string,
) {
  const tag = await getOrCreateTag(tags, tagCache, value, 'decision_reason');
  if (!tag?.id) return false;

  const decisionTags = await getCollection('DecisionTag');
  const existing = await decisionTags.list({
    limit: 1,
    where: { decisionId, tagId: tag.id, tagRole: 'reason' },
  });
  if (existing[0]) return false;

  const link = await decisionTags.create({ decisionId, tagId: tag.id, tagRole: 'reason' });
  await link.save();
  return true;
}

async function backfillDecisions(tags: TagCollection, tagCache: TagCache) {
  const decisions = await getCollection('Decision');
  const records = await listAll(decisions as ListableCollection);
  let migratedCount = 0;
  let tagCount = 0;

  for (const decision of records) {
    const decisionId = stringValue(decision.id);
    if (!decisionId) continue;

    let changed = false;
    const deciderProfileId = await getOrCreateActorProfile(decision.decisionBy);
    if (deciderProfileId && !stringValue(decision.deciderProfileId)) {
      decision.deciderProfileId = deciderProfileId;
      changed = true;
    }

    if (changed) {
      await saveRecord(decision, `decision ${decisionId}`);
      migratedCount += 1;
    }

    for (const tag of splitList(decision.decisionTags)) {
      if (await createDecisionTag(tags, tagCache, decisionId, tag)) tagCount += 1;
    }
  }

  return { migratedCount, tagCount };
}

export async function backfillSmrtNative() {
  const tags = await TagCollection.create(getSmrtOptions());
  const tagCache: TagCache = new Map();
  const companyMap = await backfillCompanies();
  const peopleCount = await backfillPeople(companyMap);
  const opportunityCount = await backfillOpportunities(companyMap, tags, tagCache);
  const sourceCount = await backfillSources();
  const taskCount = await backfillTasks(companyMap);
  const decisionResult = await backfillDecisions(tags, tagCache);

  return {
    companyCount: companyMap.size,
    decisionActorCount: decisionResult.migratedCount,
    decisionTagCount: decisionResult.tagCount,
    opportunityCount,
    peopleCount,
    sourceCount,
    taskCount,
  };
}

export function formatBackfillSummary(result: Awaited<ReturnType<typeof backfillSmrtNative>>) {
  return [
    `Backfilled ${result.companyCount} legacy companies into organization profiles.`,
    `Migrated ${result.peopleCount} legacy people relationships.`,
    `Processed ${result.opportunityCount} opportunities.`,
    `Updated ${result.sourceCount} source owners.`,
    `Updated ${result.taskCount} tasks.`,
    `Updated ${result.decisionActorCount} decision actors.`,
    `Created ${result.decisionTagCount} decision tag links.`,
  ].join('\n');
}

if (process.argv[1]?.endsWith('backfill-smrt-native.ts')) {
  console.log(formatBackfillSummary(await backfillSmrtNative()));
}
