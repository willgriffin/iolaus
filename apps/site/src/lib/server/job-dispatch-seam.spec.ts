import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { Application } from '../objects/Application.js';
import { Opportunity } from '../objects/Opportunity.js';
import { Source } from '../objects/Source.js';
import {
  AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
  AUTO_SUBMIT_APPLICATION_METHOD,
} from './auto-submit-application-job-schema.js';
import {
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
} from './opportunity-intelligence-job-schema.js';
import {
  SOURCE_CRAWL_METHOD,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules.js';
// Importing the server registration registers the local @willgriffin/iolaus-site
// objects in ObjectRegistry, mirroring how the job worker boots.
import './smrt.js';

// The worker turns a persisted job into a call like:
//   ObjectRegistry.getClass(job.objectType) -> instance[job.method](args, ctx)
// If the *_JOB_OBJECT_TYPE constant, the registry key, or the method name ever
// drift apart, jobs fail at runtime ("Unknown object type" / "Method not found")
// and nothing else in the suite catches it. These assertions guard each
// queued-object/method pairing the worker relies on (issue #53, follow-up to #52).
const dispatchPairings = [
  {
    method: OPPORTUNITY_INTELLIGENCE_METHOD,
    objectType: OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
    target: Opportunity,
  },
  {
    method: SOURCE_CRAWL_METHOD,
    objectType: SOURCE_JOB_OBJECT_TYPE,
    target: Source,
  },
  {
    method: AUTO_SUBMIT_APPLICATION_METHOD,
    objectType: AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
    target: Application,
  },
] as const;

describe('worker job dispatch seam', () => {
  it.each(
    dispatchPairings,
  )('keeps $objectType.$method wired to its registered class', ({
    method,
    objectType,
    target,
  }) => {
    // The *_JOB_OBJECT_TYPE constant must equal the key the class is actually
    // registered under (catches class/package rename drift).
    expect(ObjectRegistry.getClassByConstructor(target)?.qualifiedName).toBe(
      objectType,
    );

    // Resolving the persisted job's objectType must return that same class
    // (this is the lookup the worker performs).
    expect(
      ObjectRegistry.getClassByQualifiedName(objectType)?.constructor,
    ).toBe(target);

    // The *_METHOD constant must name a real instance method to invoke
    // (catches method rename/removal).
    expect(
      typeof (target.prototype as unknown as Record<string, unknown>)[method],
    ).toBe('function');
  });
});
