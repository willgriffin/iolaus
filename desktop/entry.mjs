import { randomUUID } from 'node:crypto';
import {
  prepareApplicationStateRoot,
  removeOriginFile,
  writeOriginFile,
} from '@happyvertical/smrt-app-runtime';

// The supervisor supplies loopback HOST/PORT/ORIGIN and the private data root.
// Product policy never inherits a hosted runtime or starts automatic crawls.
process.env.SMRT_APP_ID = 'iolaus';
process.env.SMRT_RUNTIME_PROFILE = 'local';
process.env.SMRT_BACKGROUND_JOBS = 'false';
process.env.SMRT_PROCESS_INSTANCE = randomUUID();
process.env.NODE_ENV = 'production';
if (!process.env.SMRT_DATA_DIR || !process.env.HOST) {
  throw new Error('Native launch requires supervisor data directory and host.');
}
const { prepareNativeInstallation } = await import('./setup.mjs');
await prepareNativeInstallation({
  appId: 'iolaus',
  dataDirectory: process.env.SMRT_DATA_DIR,
  sourceRoot: process.cwd(),
  bindHost: process.env.HOST,
  operationInstance: process.env.SMRT_PROCESS_INSTANCE,
});
await import('../build/index.js');

// Read-only assistant discovery uses the framework's private origin record;
// clients never need to open the application's SQLite database.
const stateRoot = prepareApplicationStateRoot({
  appId: 'iolaus',
  dataDirectory: process.env.SMRT_DATA_DIR,
  sourceRoot: process.cwd(),
});
writeOriginFile(stateRoot, process.env.ORIGIN);
process.once('exit', () => removeOriginFile(stateRoot, process.pid));
