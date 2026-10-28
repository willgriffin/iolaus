import type { MCPTool } from '@happyvertical/smrt-core/generators/mcp';
import { getCollection } from './smrt.js';

/**
 * Bounded read-only lookup of the shared tag vocabulary (`Tag` from
 * `@happyvertical/smrt-tags`), so an agent can resolve the `tagId` every
 * `*Tag` join row requires. The admin tag pickers read the same collection
 * the same way (`admin-data.ts` `listComboOptions`: the first 1000 tags by
 * name, filtered in the picker). The vocabulary is not candidate-owned and is
 * never written through this tool; `@happyvertical/smrt-tags` stays outside
 * the exposable packages, so no `tag_*` CRUD is generated.
 */

export const TAG_LOOKUP_TOOL = 'tag_lookup';

export const TAG_LOOKUP_DEFAULT_LIMIT = 25;
export const TAG_LOOKUP_MAX_LIMIT = 100;
const TAG_LOOKUP_SCAN_LIMIT = 1000;

export const tagLookupMcpTool = {
  description:
    'Look up tags in the shared vocabulary by name or slug substring and return their ids for the *Tag join records (achievement_tags, project_tags, …). Read-only and bounded.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      limit: {
        default: TAG_LOOKUP_DEFAULT_LIMIT,
        maximum: TAG_LOOKUP_MAX_LIMIT,
        minimum: 1,
        type: 'integer',
      },
      query: {
        description: 'Case-insensitive substring of the tag name or slug.',
        maxLength: 120,
        type: 'string',
      },
    },
    type: 'object',
  },
  name: TAG_LOOKUP_TOOL,
  outputSchema: { additionalProperties: true, type: 'object' },
} satisfies MCPTool;

export interface TagLookupResult {
  items: Array<{ context: string; id: string; name: string; slug: string }>;
  limit: number;
  query: string;
  scanned: number;
  truncated: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export async function lookupTags(
  args: Record<string, unknown>,
): Promise<TagLookupResult> {
  const query = text(args.query).trim().slice(0, 120).toLowerCase();
  const requested = Number(args.limit);
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, TAG_LOOKUP_MAX_LIMIT)
      : TAG_LOOKUP_DEFAULT_LIMIT;
  const collection = await getCollection('Tag');
  const rows = (await collection.list({
    limit: TAG_LOOKUP_SCAN_LIMIT,
    orderBy: 'name ASC',
  })) as unknown as Record<string, unknown>[];
  const matches = rows
    .map((row) => ({
      context: text(row.context),
      id: text(row.id),
      name: text(row.name),
      slug: text(row.slug),
    }))
    .filter(
      (tag) =>
        tag.id &&
        (!query ||
          tag.name.toLowerCase().includes(query) ||
          tag.slug.toLowerCase().includes(query)),
    );
  return {
    items: matches.slice(0, limit),
    limit,
    query,
    scanned: rows.length,
    truncated: matches.length > limit || rows.length >= TAG_LOOKUP_SCAN_LIMIT,
  };
}
