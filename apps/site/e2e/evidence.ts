import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';

/** Keep actionable runtime exceptions before global setup removes its secrets. */
export async function attachRuntimeFailure(testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const logPath = process.env.IOLAUS_E2E_LOG;
  if (!logPath || !existsSync(logPath)) return;
  const diagnostics = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => /(?:error|exception|failed|^\s+at\s)/iu.test(line))
    .slice(-160)
    .join('\n')
    .replace(/([?&](?:token|code|state)=)[^\s&#"']+/giu, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1[redacted]')
    .replace(
      /("(?:sessionId|session|accessToken|refreshToken|token)"\s*:\s*")[^"]+/giu,
      '$1[redacted]',
    );
  if (!diagnostics) return;
  if (existsSync(testInfo.outputDir)) chmodSync(testInfo.outputDir, 0o700);
  const path = testInfo.outputPath('runtime-errors.txt');
  writeFileSync(path, diagnostics, { mode: 0o600 });
  await testInfo.attach('sanitized runtime exceptions', {
    path,
    contentType: 'text/plain',
  });
}
