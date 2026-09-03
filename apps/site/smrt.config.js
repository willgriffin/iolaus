const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://iolaus:iolaus@localhost:54329/iolaus_dev';

export default {
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
        type: 'postgres',
        url: databaseUrl,
      },
      verbose: false,
    },
  },
};
