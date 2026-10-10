import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { backfillOpportunityAnalyses, pruneExpiredOpportunityAnalyses } from '../src/lib/server/opportunity-analysis-maintenance.js';

const usage='Usage: opportunities:analyze --backfill --max N [--cursor TOKEN] [--enrich --budget-micros M] [--prune]';
const args=process.argv.slice(2).filter(arg=>arg!=='--');
const values=new Map<string,string>();
const flags=new Set<string>();
for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(['--backfill','--enrich','--prune'].includes(arg)){if(flags.has(arg))throw new Error(usage);flags.add(arg);}
  else if(['--max','--cursor','--budget-micros'].includes(arg)&&args[i+1]&&!args[i+1].startsWith('--')){if(values.has(arg))throw new Error(usage);values.set(arg,args[++i]);}
  else throw new Error(usage);
}
if(!flags.has('--backfill')&&!flags.has('--prune'))throw new Error(usage);
const result:Record<string,unknown>={};
if(flags.has('--backfill'))result.backfill=await backfillOpportunityAnalyses({max:Number(values.get('--max')??100),cursor:values.get('--cursor'),enrich:flags.has('--enrich'),budgetMicros:values.has('--budget-micros')?Number(values.get('--budget-micros')):undefined});
if(flags.has('--prune'))result.pruned=await pruneExpiredOpportunityAnalyses(await resolveDatabase(getDbConfig()));
// Aggregate counts and opaque resume cursor only; never posting or user payloads.
console.log(JSON.stringify(result));
