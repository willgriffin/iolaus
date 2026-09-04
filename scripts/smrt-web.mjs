#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs';
import { writeProcessRecord } from './smrt-process.mjs';

const instance = process.argv
  .find((value) => value.startsWith('--smrt-instance='))
  ?.slice('--smrt-instance='.length);
if (!instance || !/^[a-f0-9]{32}$/.test(instance)) {
  throw new Error('A valid application process identity is required.');
}

const stopNonce = process.env.SMRT_STOP_NONCE;
const stopRequest = process.env.SMRT_STOP_REQUEST;
const processRecord = process.env.SMRT_PROCESS_RECORD;
if (
  !stopNonce ||
  !/^[a-f0-9]{32}$/.test(stopNonce) ||
  !stopRequest ||
  !processRecord
) {
  throw new Error('A valid application stop channel is required.');
}

writeProcessRecord(processRecord, {
  pid: process.pid,
  instance,
  stopNonce,
});

const stopPoll = setInterval(() => {
  try {
    const request = JSON.parse(readFileSync(stopRequest, 'utf8'));
    if (
      request?.schemaVersion === 1 &&
      request.instance === instance &&
      request.stopNonce === stopNonce
    ) {
      rmSync(stopRequest, { force: true });
      process.kill(process.pid, 'SIGTERM');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Invalid requests are inert and remain available for operator inspection.
    }
  }
}, 100);
stopPoll.unref();

await import('../apps/site/build/index.js');
