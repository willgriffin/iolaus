import type { MCPTool } from '@happyvertical/smrt-core/generators/mcp';

/**
 * Owner-principal MCP tool contracts for the public résumé profile
 * lifecycle. They wrap the service functions the admin form actions call
 * (`public-profile-service.ts`), so the preview-then-publish step, the
 * 20-previews-per-48-hours limit and the artifact integrity checks are the
 * same on every surface. This module holds schemas only: the legacy
 * `/api/mcp/call` catalog (`mcp-tools.ts`, which the `iolaus mcp` commands
 * use) and the canonical `POST /api/mcp` server (`mcp-app-server.ts`) both
 * register from it, and the owner principal's allow-list derives from the
 * former.
 */

export const PUBLIC_PROFILE_PREPARE_TOOL = 'public_profile_prepare';
export const PUBLIC_PROFILE_PUBLISH_TOOL = 'public_profile_publish';
export const PUBLIC_PROFILE_UNPUBLISH_TOOL = 'public_profile_unpublish';
export const PUBLIC_PROFILE_STATUS_TOOL = 'public_profile_status';

export const publicProfileToolNames = [
  PUBLIC_PROFILE_PREPARE_TOOL,
  PUBLIC_PROFILE_PUBLISH_TOOL,
  PUBLIC_PROFILE_UNPUBLISH_TOOL,
  PUBLIC_PROFILE_STATUS_TOOL,
] as const;

export type PublicProfileToolName = (typeof publicProfileToolNames)[number];

const publicProfileToolNameSet = new Set<string>(publicProfileToolNames);

export function isPublicProfileToolName(
  name: string,
): name is PublicProfileToolName {
  return publicProfileToolNameSet.has(name);
}

const booleanFlags = (keys: readonly string[]) => ({
  additionalProperties: false,
  properties: Object.fromEntries(
    keys.map((key) => [key, { default: false, type: 'boolean' }]),
  ),
  type: 'object',
});

export const publicProfileRevisionInputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    expectedRevision: {
      description:
        'The identity revision the preview was prepared against (`baseRevision` from prepare, or `identity.revision` from status). A stale value is refused.',
      minimum: 0,
      type: 'integer',
    },
    revisionId: {
      description: 'The prepared preview revision to publish.',
      format: 'uuid',
      type: 'string',
    },
  },
  required: ['revisionId', 'expectedRevision'],
  type: 'object',
} as const;

const outputSchema = { additionalProperties: true, type: 'object' } as const;

export const publicProfileMcpTools = [
  {
    description:
      'Prepare an immutable public résumé preview from one owned candidate profile: captures the current résumé facts, renders the PDF and stores a prepared revision. Nothing becomes public until public_profile_publish. At most 20 previews per 48 hours.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {
        handle: {
          description:
            'Public handle (`/people/<handle>`). The first reserved handle is immutable.',
          maxLength: 64,
          minLength: 1,
          type: 'string',
        },
        profileId: {
          description:
            'Owned CandidateProfile id to publish from (see candidateprofile_list).',
          maxLength: 128,
          minLength: 1,
          type: 'string',
        },
        visibility: {
          additionalProperties: false,
          properties: {
            contacts: booleanFlags(['email', 'phone', 'location', 'links']),
            sections: booleanFlags([
              'education',
              'experience',
              'other',
              'skills',
            ]),
          },
          required: ['contacts', 'sections'],
          type: 'object',
        },
      },
      required: ['handle', 'profileId', 'visibility'],
      type: 'object',
    },
    name: PUBLIC_PROFILE_PREPARE_TOOL,
    outputSchema,
  },
  {
    description:
      'Publish a prepared public résumé preview after reviewing it. Verifies the exact reviewed PDF still exists and that the identity revision has not moved.',
    inputSchema: publicProfileRevisionInputSchema,
    name: PUBLIC_PROFILE_PUBLISH_TOOL,
    outputSchema,
  },
  {
    description:
      'Withdraw the current public résumé profile. Later anonymous HTML and PDF requests are denied; the handle stays reserved.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {
        expectedRevision: {
          description: 'Current identity revision from public_profile_status.',
          minimum: 0,
          type: 'integer',
        },
      },
      required: ['expectedRevision'],
      type: 'object',
    },
    name: PUBLIC_PROFILE_UNPUBLISH_TOOL,
    outputSchema,
  },
  {
    description:
      'Read the signed-in owner’s public résumé profile state: identity (handle, status, revision), the owned candidate profiles that can be published, the pending prepared preview, and the public URL.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {},
      type: 'object',
    },
    name: PUBLIC_PROFILE_STATUS_TOOL,
    outputSchema,
  },
] satisfies MCPTool[];
