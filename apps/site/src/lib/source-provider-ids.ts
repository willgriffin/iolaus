export const sourceProviderIds = [
  'a16z-portfolio',
  'aijobs',
  'amazon-jobs',
  'apple-careers',
  'ashby',
  'automattic-careers',
  'canonical-careers',
  'freelancer',
  'gemini-careers',
  'generic-careers',
  'google-careers',
  'greenhouse',
  'hacker-news',
  'lever',
  'linkedin',
  'microsoft-careers',
  'oracle-careers',
  'peopleperhour',
  'remote-com',
  'remoteok',
  'remoterocketship',
  'remotive',
  'weworkremotely',
  'wellfound',
  'workday',
  'workingnomads',
  'ycombinator',
] as const;

export type SourceProviderId = (typeof sourceProviderIds)[number];

const sourceProviderIdSet = new Set<string>(sourceProviderIds);

export function isSourceProviderId(value: string): value is SourceProviderId {
  return sourceProviderIdSet.has(value);
}
