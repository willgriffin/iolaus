import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLocalRuntimePaths } from '@happyvertical/smrt-app-runtime';
import { canonicalizeDataDirectory } from '../../scripts/smrt-runtime-identity.mjs';

const sourceRoot = existsSync(resolve(process.cwd(), 'apps/site/package.json'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
const profile = process.env.SMRT_RUNTIME_PROFILE || 'local';
const appId = process.env.SMRT_APP_ID || 'iolaus';
const localDatabase =
  profile === 'local'
    ? resolveLocalRuntimePaths({
        appId,
        dataDirectory: canonicalizeDataDirectory(process.env.SMRT_DATA_DIR),
        sourceRoot,
      }).database
    : undefined;

export default {
  runtime: {
    profile,
  },
  smrt: {
    logLevel: 'info',
    schemaMigration: {
      strategy: 'auto-add',
    },
  },
  packages: {
    ai: {
      baseUrl: 'https://models.example.invalid',
      defaultProfile: 'cheap',
      defaultProvider: 'bifrost',
      profiles: {
        cheap: {
          model: 'openai/gpt-5.6-luna',
          provider: 'bifrost',
        },
        good: {
          model: 'openai/gpt-5.6-terra',
          provider: 'bifrost',
        },
        'opportunity-intelligence-fallback': {
          model: 'openai/gpt-5.6-luna',
          provider: 'bifrost',
        },
        'opportunity-intelligence-zai': {
          model: 'zai/glm-4.7-flashx',
          provider: 'bifrost',
        },
      },
    },
    cli: {
      database: {
        type: profile === 'local' ? 'sqlite' : 'postgres',
        url:
          profile === 'local'
            ? process.env.DATABASE_URL || localDatabase
            : process.env.DATABASE_URL,
      },
      verbose: false,
    },
  },
};
