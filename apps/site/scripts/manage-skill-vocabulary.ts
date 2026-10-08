import '../src/lib/server/manifest-preload.js';
import { promoteSkillTerm, refreshSkillVocabularyLookup } from '../src/lib/server/skill-vocabulary.js';
const args=process.argv.slice(2).filter(arg=>arg!=='--');
const usage='Usage: skills:vocabulary refresh | promote --label NAME [--slug SLUG] [--aliases a,b] [--category NAME] [--related-json JSON]';
const command=args.shift();
const values=new Map<string,string>();
for(let i=0;i<args.length;i+=2){
  const key=args[i],value=args[i+1];
  if(!['--label','--slug','--aliases','--category','--related-json'].includes(key)||values.has(key)||value===undefined||value.startsWith('--')||value.length>12000) throw new Error(usage);
  values.set(key,value);
}
if(command==='refresh'&&values.size===0) console.log(JSON.stringify({active:await refreshSkillVocabularyLookup()}));
else if(command==='promote'){
 const label=values.get('--label');if(!label)throw new Error(usage);
 const aliases=(values.get('--aliases')??'').split(',').map(value=>value.trim()).filter(Boolean);
 const related=JSON.parse(values.get('--related-json')??'[]');
 const term=await promoteSkillTerm({label,aliases,related,slug:values.get('--slug'),category:values.get('--category')});
 console.log(JSON.stringify(term));
}else throw new Error(usage);
