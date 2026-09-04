import {
  KeyedLockTimeoutError,
  withKeyedFileLock,
} from '../../../../../scripts/smrt-keyed-lock.mjs';
import {
  prepareApplicationStateRoot,
  resolveApplicationId,
} from '../../../../../scripts/smrt-runtime-identity.mjs';
import {
  getIolausSourceRoot,
  IOLAUS_APPLICATION_ID,
  resolveIolausLocalRuntimePaths,
} from './runtime-paths.js';

export { KeyedLockTimeoutError };

export async function withSqliteOperationLock<T>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const sourceRoot = getIolausSourceRoot();
  const appId = resolveApplicationId({
    sourceRoot,
    explicitId: process.env.SMRT_APP_ID || IOLAUS_APPLICATION_ID,
  });
  return await withKeyedFileLock(
    {
      stateRoot: prepareApplicationStateRoot({
        appId,
        dataDirectory: resolveIolausLocalRuntimePaths().root,
        sourceRoot,
      }),
      key,
      timeoutMs: 15_000,
      retryMs: 100,
    },
    action,
  );
}
