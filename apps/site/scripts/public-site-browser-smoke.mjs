import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync} from 'node:fs';
const base=process.env.PUBLIC_SITE_URL;
const evidence=process.env.PUBLIC_SITE_EVIDENCE_DIR;
if(!base || !evidence || !process.env.PUBLIC_SITE_FIXTURE) throw new Error('Set PUBLIC_SITE_URL, PUBLIC_SITE_EVIDENCE_DIR and PUBLIC_SITE_FIXTURE (JSON with ids and companyId).');
const fixture=JSON.parse(readFileSync(process.env.PUBLIC_SITE_FIXTURE,'utf8'));
const browser=await chromium.launch({executablePath:process.env.PUBLIC_SITE_CHROME,headless:true});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];
for(const path of ['/', '/opportunities/',`/opportunities/${fixture.ids[0]}/`,`/companies/${fixture.companyId}/`,'/skills/typescript/']){
 const response=await page.goto(base+path);await page.waitForTimeout(300);
 const body=await page.locator('body').innerText();
 results.push({path,status:response.status(),title:await page.title(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),privateLeak:body.includes('PRIVATE_OVERLAY_NEVER_PUBLIC'),text:body.slice(0,1600)});
 await page.screenshot({path:evidence+'/mobile-'+(path==='/'?'home':path.replaceAll('/','-'))+'.png',fullPage:true});
}
await page.goto(base+'/opportunities/');await page.waitForLoadState('networkidle');await page.getByLabel('Keywords').fill('TypeScript');await page.getByRole('button',{name:'Search',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('q')==='TypeScript');await page.getByText('1 opportunities',{exact:true}).waitFor();results.push({filter:await page.locator('main').innerText()});
await page.goto(base+'/');await page.waitForLoadState('networkidle');
const firstListing=page.getByRole('link',{name:'Rust Systems Engineer',exact:true});
const listingBox=await firstListing.boundingBox();
if(!listingBox || listingBox.y>=844) throw new Error('Latest listing must be above mobile fold');
await page.getByLabel('Add a skill',{exact:true}).fill('typescript');
await page.getByLabel('Add a skill',{exact:true}).press('Enter');
await page.getByRole('button',{name:'Match skills',exact:true}).focus();
await page.keyboard.press('Enter');
await page.getByText('Model calls: 0.',{exact:false}).waitFor();
const matchText=await page.locator('.match').innerText();
if(!matchText.includes('Skill coverage:') || !matchText.includes('Missing:') || !matchText.includes('Unknown requirements:')) throw new Error('Missing match explanation');
results.push({keyboardMatch:true,matchText});
await page.screenshot({path:evidence+'/mobile-match-panel.png',fullPage:true});
await page.route('**/api/public/v1/match',async route=>{await new Promise(resolve=>setTimeout(resolve,500));try{await route.fulfill({json:{items:[],model_calls:0}});}catch{}});
await page.getByRole('button',{name:'Match skills',exact:true}).click();
await page.getByRole('button',{name:'Clear skills',exact:true}).click();
await page.waitForTimeout(700);
if(await page.getByText('Model calls: 0.',{exact:false}).count()) throw new Error('Stale match response restored cleared results');
results.push({staleResponseSuppressed:true});
writeFileSync(evidence+'/mobile-results.json',JSON.stringify({results,errors},null,2));await browser.close();console.log(JSON.stringify({results,errors},null,2));

if(errors.length || results.some(r=>r.status && (r.status!==200 || r.overflow || r.privateLeak)) || !results.some(r=>r.filter?.includes('1 opportunities'))) throw new Error('Public mobile smoke assertions failed; inspect evidence JSON.');
