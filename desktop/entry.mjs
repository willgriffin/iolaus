import { randomUUID } from 'node:crypto';
// The supervisor supplies loopback HOST/PORT/ORIGIN and the private data root.
// Product policy never inherits a hosted runtime or starts automatic crawls.
process.env.SMRT_APP_ID = 'iolaus';
process.env.SMRT_RUNTIME_PROFILE = 'local';
process.env.SMRT_BACKGROUND_JOBS = 'false';
process.env.SMRT_PROCESS_INSTANCE = randomUUID();
process.env.NODE_ENV = 'production';
await import('../build/index.js');
