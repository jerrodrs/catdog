import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {generateGrokArt,generatedImage} from '../grok-art.mjs';import {Store} from '../store.mjs';import {JobQueue} from '../runner.mjs';
const root=path.resolve(new URL('../..',import.meta.url).pathname);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-grok-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const home=path.join(dir,'grok'),job=path.join(dir,'job');fs.mkdirSync(path.join(home,'sessions','fixture'),{recursive:true});fs.mkdirSync(job);
 const source=path.join(home,'sessions','fixture','image.png');execFileSync('python3',['-c',"from PIL import Image; import sys; Image.new('RGB',(256,384),'#78946b').save(sys.argv[1])",source]);
 const binary=path.join(dir,'fake-grok');fs.writeFileSync(binary,`#!/usr/bin/env node\nimport fs from 'node:fs';if(process.env.XAI_API_KEY||process.env.GROK_DISABLE_API_KEY_AUTH!=='true')throw Error('API authentication leaked');const tools=process.argv[process.argv.indexOf('--tools')+1],kind=tools==='image_edit'?'ImageEdit':'ImageGen';fs.appendFileSync(${JSON.stringify(path.join(dir,'calls'))},'call\\n');console.log(JSON.stringify({type:'tool_call',toolCallId:'test',toolName:tools}));console.log(JSON.stringify({type:'tool_call_update',toolCallId:'test',status:'completed',rawOutput:{type:kind,path:${JSON.stringify(source)}}}));`,{mode:0o755});
 const requestPath=path.join(job,'request.json'),planPath=path.join(job,'art-plan.json'),outputPath=path.join(job,'art.png');fs.writeFileSync(requestPath,JSON.stringify({output_directory:job,project_root:dir,image_generation:{provider:'grok-cli'}}));fs.writeFileSync(planPath,JSON.stringify({prompt:'A painterly woodland scene; no text.'}));
 return {dir,home,job,source,requestPath,planPath,outputPath,binary,env:{...process.env,GROK_HOME:home,XAI_API_KEY:'must-never-reach-grok'},timeoutMs:10000};
}
test('Grok CLI copies actual tool artifacts, strips API auth, records resizing and reuses a completed local result',async t=>{
 const f=fixture(t),r=await generateGrokArt(f);assert.deepEqual(r.native_dimensions,[256,384]);assert.deepEqual(r.prepared_dimensions,[1500,2250]);assert.equal(r.upscaled,true);assert.deepEqual(fs.readFileSync(r.source_path),fs.readFileSync(f.source));assert.ok(fs.existsSync(r.output_path));
 assert.equal((await generateGrokArt(f)).cached,true);assert.equal(fs.readFileSync(path.join(f.dir,'calls'),'utf8'),'call\n');
 fs.writeFileSync(f.planPath,JSON.stringify({prompt:'Another image'}));await assert.rejects(generateGrokArt(f),/already exists/);
 assert.throws(()=>generatedImage(JSON.stringify({type:'text',data:f.source})),/did not return/);
});
test('Grok edits accept previous-provider raw art as a reference and reject unrelated files',async t=>{
 const f=fixture(t),previous=path.join(f.dir,'previous');fs.mkdirSync(previous);const art=path.join(previous,'raw.png');fs.copyFileSync(f.source,art);
 const request=JSON.parse(fs.readFileSync(f.requestPath));request.previous_version={manifest_path:path.join(previous,'manifest.json'),summary:{art:'raw.png'}};fs.writeFileSync(f.requestPath,JSON.stringify(request));fs.writeFileSync(f.planPath,JSON.stringify({prompt:'Change the lighting and preserve the subject.',reference_images:[art]}));
 const r=await generateGrokArt(f);assert.deepEqual(r.reference_paths,[art]);const events=fs.readFileSync(r.events_path,'utf8');assert.match(events,/ImageEdit/);
 fs.writeFileSync(f.planPath,JSON.stringify({prompt:'Invalid reference',reference_images:[path.join(f.dir,'calls')]}));await assert.rejects(generateGrokArt({...f,outputPath:path.join(f.job,'other.png')}),/local project reference/);
});
test('deck provider selection freezes each job and switches existing cards without changing earlier versions',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-provider-')),store=new Store(dir),queue=new JobQueue(store,root,{imageProviderStatus:()=>[{id:'grok-cli',available:true}]});queue.setPaused(true);t.after(()=>{queue.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const deck=store.createDeck({name:'Switch providers',image_provider:'codex'},[{name:'Sol Ring',quantity:1,section:'main'}]),card=deck.cards[0];
 const version=store.addVersion(card.id,{id:'prior-version',summary:{id:'sol-ring',name:'Sol Ring',art:'old-gpt.png'},image_path:path.join(dir,'old-gpt.png'),manifest_path:path.join(dir,'manifest.json')});
 const first=queue.enqueue(deck.id,{mode:'all'})[0],firstRequest=JSON.parse(fs.readFileSync(path.join(store.get('SELECT directory FROM jobs WHERE id=?',first).directory,'request.json')));assert.equal(firstRequest.image_generation.provider,'codex');queue.cancel(first);
 store.updateDeck(deck.id,{image_provider:'grok-cli'});const second=queue.enqueue(deck.id,{mode:'selected',card_ids:[card.id],type:'revise',instructions:'Change the lighting.'})[0],job=store.get('SELECT * FROM jobs WHERE id=?',second),request=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json')));
 assert.equal(request.image_generation.provider,'grok-cli');assert.equal(request.previous_version.summary.art,'old-gpt.png');assert.match(queue.prompt(request,path.join(job.directory,'request.json')),/ENTIRE card workflow/);assert.doesNotMatch(queue.prompt(request,''),/node studio\/grok-art.mjs/);assert.equal(store.versions(card.id).length,1);
 store.updateDeck(deck.id,{image_provider:'codex'});assert.equal(JSON.parse(fs.readFileSync(path.join(job.directory,'request.json'))).image_generation.provider,'grok-cli');queue.cancel(second);
 const third=queue.enqueue(deck.id,{mode:'all'})[0],thirdRequest=JSON.parse(fs.readFileSync(path.join(store.get('SELECT directory FROM jobs WHERE id=?',third).directory,'request.json')));assert.equal(thirdRequest.image_generation.provider,'codex');assert.match(queue.prompt(thirdRequest,''),/even if an earlier version used Grok/);
 assert.throws(()=>store.updateDeck(deck.id,{image_provider:'paid-api'}),/Choose Codex or Grok/);
});

async function finished(queue,jobId){const start=Date.now();while(Date.now()-start<20000){const job=queue.store.get('SELECT * FROM jobs WHERE id=?',jobId);if(['succeeded','failed','cancelled'].includes(job.status))return job;await new Promise(r=>setTimeout(r,30));}throw Error('Provider workflow timed out');}
function cardQueue(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-full-grok-')),store=new Store(dir),queue=new JobQueue(store,root,{binary:'/does-not-exist-codex',grokBinary:path.join(root,'studio/tests/fixtures/fake-grok-card.py'),imageProviderStatus:()=>[{id:'grok-cli',available:true}],retryBaseMs:10});t.after(async()=>{queue.close();while(queue.activeJobs.size)await new Promise(r=>setTimeout(r,20));store.close();fs.rmSync(dir,{recursive:true,force:true});});const deck=store.createDeck({name:'Entire Grok workflow',image_provider:'grok-cli',style:'A test art direction'},[{name:'Sol Ring',quantity:1,section:'main'}]);return {dir,store,queue,deck};}

test('Grok alone completes the whole card pipeline with Codex unavailable, then either provider can revise it',async t=>{
 const {store,queue,deck}=cardQueue(t),card=deck.cards[0];
 const first=await finished(queue,queue.enqueue(deck.id)[0]);assert.equal(first.status,'succeeded',first.error);
 const grokVersion=store.versions(card.id)[0];assert.equal(grokVersion.summary.display_name,'Grok-crafted Hearthstone');assert.equal(grokVersion.summary.flavor_text,'A Grok-authored flavour line.');assert.equal(first.thread_id,'grok-fixture-session');assert.ok(fs.existsSync(path.join(first.directory,'grok-prompt.txt')));assert.equal(fs.existsSync(path.join(first.directory,'codex-prompt.txt')),false);
 queue.binary=path.join(root,'studio/tests/fixtures/fake-codex.py');store.updateDeck(deck.id,{image_provider:'codex'});
 const second=await finished(queue,queue.enqueue(deck.id,{mode:'selected',card_ids:[card.id],type:'revise',instructions:'Change the lighting.'})[0]);assert.equal(second.status,'succeeded',second.error);assert.equal(store.versions(card.id)[0].summary.display_name,'Revised Hearthstone');assert.ok(fs.existsSync(grokVersion.image_path));
 store.updateDeck(deck.id,{image_provider:'grok-cli'});queue.binary='/does-not-exist-codex';
 const third=await finished(queue,queue.enqueue(deck.id,{mode:'selected',card_ids:[card.id],type:'revise',instructions:'Change the light again.'})[0]);assert.equal(third.status,'succeeded',third.error);assert.equal(store.versions(card.id).length,3);assert.equal(store.versions(card.id)[0].summary.display_name,'Grok-crafted Hearthstone');
});

test('Grok errors never invoke Codex and automatic retries keep the entire job on Grok',async t=>{
 const {store,queue,deck}=cardQueue(t),card=deck.cards[0];
 const blocked=await finished(queue,queue.enqueue(deck.id,{mode:'all',instructions:'GROK_BLOCKED'})[0]);assert.equal(blocked.status,'failed');assert.match(blocked.error,/Grok image tool unavailable/);assert.equal(store.versions(card.id).length,0);
 const retry=await finished(queue,queue.enqueue(deck.id,{mode:'all',instructions:'GROK_RATE_LIMIT_ONCE'})[0]);assert.equal(retry.status,'succeeded',retry.error);assert.equal(retry.retry_count,1);const request=JSON.parse(fs.readFileSync(path.join(retry.directory,'request.json')));assert.equal(request.image_generation.provider,'grok-cli');assert.ok(fs.existsSync(path.join(retry.directory,'grok-prompt.txt')));
});

test('a Grok cooldown skips older Grok jobs while Codex continues, using each frozen job provider',async t=>{
 const {store,queue,deck}=cardQueue(t);queue.setPaused(true);queue.binary=path.join(root,'studio/tests/fixtures/fake-codex.py');queue.setProviderCooldown('grok-cli',Date.now()+60000);
 const blocked=queue.enqueue(deck.id)[0];store.updateDeck(deck.id,{image_provider:'codex'});
 const other=store.createDeck({name:'Codex continues',image_provider:'codex'},[{name:'Sol Ring',quantity:1,section:'main'}]);const allowed=queue.enqueue(other.id)[0];queue.setPaused(false);
 const done=await finished(queue,allowed);assert.equal(done.status,'succeeded',done.error);assert.equal(store.get('SELECT status FROM jobs WHERE id=?',blocked).status,'queued');assert.equal(store.get('SELECT generation_provider FROM jobs WHERE id=?',blocked).generation_provider,'grok-cli');assert.equal(queue.cooldownFor('codex'),0);queue.cancel(blocked);
});

test('a Codex cooldown lets Grok continue and local recomposition bypasses both provider cooldowns',async t=>{
 const {store,queue,deck}=cardQueue(t);queue.setPaused(true);queue.setProviderCooldown('codex',Date.now()+60000);
 const other=store.createDeck({name:'Codex waits',image_provider:'codex'},[{name:'Sol Ring',quantity:1,section:'main'}]);const blocked=queue.enqueue(other.id)[0],allowed=queue.enqueue(deck.id)[0];queue.setPaused(false);
 const done=await finished(queue,allowed);assert.equal(done.status,'succeeded',done.error);assert.equal(store.get('SELECT status FROM jobs WHERE id=?',blocked).status,'queued');assert.equal(queue.cooldownFor('grok-cli'),0);
 queue.setProviderCooldown('grok-cli',Date.now()+60000);queue.grokBinary='/must-not-invoke-grok';
 const composed=await finished(queue,queue.enqueue(deck.id,{mode:'selected',card_ids:[deck.cards[0].id],type:'compose'})[0]);assert.equal(composed.status,'succeeded',composed.error);assert.equal(store.get('SELECT status FROM jobs WHERE id=?',blocked).status,'queued');queue.cancel(blocked);
});

test('provider cooldowns persist independently through queue restarts',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-cooldown-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const first=new JobQueue(store,root);first.setPaused(true);const grok=Date.now()+60000,codex=Date.now()+120000;first.setProviderCooldown('grok-cli',grok);first.close();
 const second=new JobQueue(store,root);second.setPaused(true);assert.equal(second.cooldownFor('grok-cli'),grok);assert.equal(second.cooldownFor('codex'),0);second.setProviderCooldown('codex',codex);assert.equal(second.cooldownFor('grok-cli'),grok);assert.deepEqual(second.cooldownStatus(),{'codex':new Date(codex).toISOString(),'grok-cli':new Date(grok).toISOString()});second.close();
});

test('legacy cooldown migration restores the provider from queued request snapshots, not current deck settings',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-migration-'));let store=new Store(dir);const queue=new JobQueue(store,root,{imageProviderStatus:()=>[{id:'grok-cli',available:true}]});queue.setPaused(true);
 const deck=store.createDeck({name:'Old queue',image_provider:'grok-cli'},[{name:'Sol Ring',quantity:1,section:'main'}]),job=queue.enqueue(deck.id)[0],until=new Date(Date.now()+60000).toISOString();store.updateDeck(deck.id,{image_provider:'codex'});store.run('UPDATE jobs SET not_before=? WHERE id=?',until,job);queue.close();
 store.db.exec('ALTER TABLE jobs DROP COLUMN generation_provider');store.run("DELETE FROM settings WHERE key='queue_provider_cooldowns'");store.run("INSERT INTO settings(key,value) VALUES('queue_cooldown_until',?)",String(Date.parse(until)));store.close();
 store=new Store(dir,{recover:false});const restored=new JobQueue(store,root);restored.setPaused(true);assert.equal(store.get('SELECT generation_provider FROM jobs WHERE id=?',job).generation_provider,'grok-cli');assert.equal(restored.cooldownFor('grok-cli'),Date.parse(until));assert.equal(restored.cooldownFor('codex'),0);assert.equal(store.get("SELECT value FROM settings WHERE key='queue_cooldown_until'"),undefined);restored.close();store.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('a provider wakes when its cooldown expires while the other provider is still generating',async t=>{
 const {store,queue,deck}=cardQueue(t);queue.setPaused(true);queue.setConcurrency(2);queue.binary=path.join(root,'studio/tests/fixtures/fake-codex.py');
 const other=store.createDeck({name:'Long Codex job',image_provider:'codex'},[{name:'Slow Card Other',quantity:1,section:'main'}]);const long=queue.enqueue(other.id)[0];queue.setProviderCooldown('grok-cli',Date.now()+400);const waiting=queue.enqueue(deck.id)[0];queue.setPaused(false);
 const done=await finished(queue,waiting);assert.equal(done.status,'succeeded',done.error);assert.equal(store.get('SELECT status FROM jobs WHERE id=?',long).status,'running');queue.cancel(long);
});

test('Codex and Grok each get their own worker slots and lowering one limit leaves the other untouched',async t=>{
 const {store,queue}=cardQueue(t);queue.setPaused(true);queue.binary=path.join(root,'studio/tests/fixtures/fake-codex.py');queue.setConcurrency(2);
 const codex=store.createDeck({name:'Codex workers',image_provider:'codex'},['One','Two','Three'].map(n=>({name:'Slow Card '+n,quantity:1,section:'main'})));
 const grok=store.createDeck({name:'Grok workers',image_provider:'grok-cli'},['One','Two','Three'].map(n=>({name:'Grok Slow '+n,quantity:1,section:'main'})));
 queue.enqueue(codex.id);queue.enqueue(grok.id,{instructions:'GROK_STALL_ALWAYS'});queue.setPaused(false);
 async function waitFor(fn){for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Worker assertion timed out');}
 await waitFor(()=>queue.activeFor('codex')===2&&queue.activeFor('grok-cli')===2);
 assert.equal(queue.activeJobs.size,4);assert.equal(store.all("SELECT id FROM jobs WHERE deck_id=? AND status='queued'",codex.id).length,1);assert.equal(store.all("SELECT id FROM jobs WHERE deck_id=? AND status='queued'",grok.id).length,1);
 queue.setConcurrency(1,'grok-cli');assert.equal(queue.providerConcurrency.codex,2);assert.equal(queue.activeFor('grok-cli'),2);
 const grokActive=store.get("SELECT id FROM jobs WHERE deck_id=? AND status='running'",grok.id);queue.cancel(grokActive.id);await waitFor(()=>queue.activeFor('grok-cli')===1);await new Promise(r=>setTimeout(r,100));assert.equal(queue.activeFor('grok-cli'),1);
 const codexActive=store.get("SELECT id FROM jobs WHERE deck_id=? AND status='running'",codex.id),waiting=store.get("SELECT id FROM jobs WHERE deck_id=? AND status='queued'",codex.id);queue.cancel(codexActive.id);await waitFor(()=>store.get('SELECT status FROM jobs WHERE id=?',waiting.id).status==='running');assert.equal(queue.activeFor('codex'),2);
});

test('per-provider worker limits persist independently through restarts',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-workers-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const first=new JobQueue(store,root);first.setPaused(true);first.setConcurrency(2);first.setConcurrency(3,'grok-cli');first.close();
 const second=new JobQueue(store,root);second.setPaused(true);assert.deepEqual(second.providerConcurrency,{codex:2,'grok-cli':3});second.close();
});

test('both providers receive explicit art-technique requirements and subordinate scene suggestions',t=>{
 const {queue,deck}=cardQueue(t);queue.setPaused(true);
 for(const provider of ['codex','grok-cli']){
  const request={type:'generate',output_directory:'/tmp/style-prompt-test',style_file:'/tmp/style-prompt-test/style.txt',image_generation:{provider}};
  const prompt=queue.prompt(request,'/tmp/style-prompt-test/request.json');
  assert.match(prompt,/ART STYLE FIDELITY/);assert.match(prompt,/requirements, not loose inspiration/);assert.match(prompt,/wording must be injected VERBATIM/);assert.match(prompt,/studio\/art-prompt.mjs/);assert.match(prompt,/Scene-plan suggestions, previous deck images and general workflow examples do not override explicit art-technique requirements/);assert.match(prompt,/optional starting suggestion, not an additional art style/);assert.match(prompt,/Save the actual image-tool prompt for review/);
 }
});
test('a card provider overrides its deck provider for new jobs only',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-card-provider-')),store=new Store(dir);let grokReady=true;const queue=new JobQueue(store,root,{imageProviderStatus:()=>[{id:'grok-cli',available:grokReady}]});queue.setPaused(true);t.after(()=>{queue.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const deck=store.createDeck({name:'Mixed providers',image_provider:'codex'},[{name:'Sol Ring',quantity:1,section:'main'},{name:'Arcane Signet',quantity:1,section:'main'}]),[ring,signet]=deck.cards;
 store.updateCard(ring.id,{image_provider:'grok-cli'});const providerOf=job=>store.get('SELECT generation_provider FROM jobs WHERE id=?',job).generation_provider;
 const jobs=queue.enqueue(deck.id,{mode:'all'}),byCard=Object.fromEntries(jobs.map(j=>[store.get('SELECT card_id FROM jobs WHERE id=?',j).card_id,j]));
 assert.equal(providerOf(byCard[ring.id]),'grok-cli');assert.equal(providerOf(byCard[signet.id]),'codex');assert.equal(JSON.parse(fs.readFileSync(path.join(store.get('SELECT directory FROM jobs WHERE id=?',byCard[ring.id]).directory,'request.json'))).image_generation.provider,'grok-cli');
 store.updateCard(ring.id,{image_provider:''});assert.equal(providerOf(byCard[ring.id]),'grok-cli');for(const j of jobs)queue.cancel(j);
 assert.equal(providerOf(queue.enqueue(deck.id,{mode:'selected',card_ids:[ring.id]})[0]),'codex');
 assert.equal(store.duplicate(deck.id).cards.length,2);store.updateCard(signet.id,{image_provider:'grok-cli'});assert.equal(store.duplicate(deck.id).cards.find(c=>c.name==='Arcane Signet').image_provider,'grok-cli');
 grokReady=false;assert.throws(()=>queue.enqueue(deck.id,{mode:'selected',card_ids:[signet.id]}),/Grok CLI/);
 assert.throws(()=>store.updateCard(ring.id,{image_provider:'paid-api'}),/Choose Codex or Grok/);
});
test('versions record which AI made their artwork, inherited through recomposition, copies and the backfill',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-art-provider-'));let store=new Store(dir);const queue=new JobQueue(store,root,{imageProviderStatus:()=>[{id:'grok-cli',available:true}]});queue.setPaused(true);t.after(()=>{queue.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const deck=store.createDeck({name:'Provenance',image_provider:'codex'},[{name:'Sol Ring',quantity:1,section:'main'}]),card=deck.cards[0];store.updateCard(card.id,{image_provider:'grok-cli'});
 const complete=jobId=>{const job=store.get('SELECT * FROM jobs WHERE id=?',jobId);store.addVersion(card.id,{id:job.version_id,job_id:job.id,image_path:path.join(job.directory,'card.png'),summary:{name:'Sol Ring'}});store.run("UPDATE jobs SET status='succeeded' WHERE id=?",jobId);return job.version_id;};
 const generated=complete(queue.enqueue(deck.id,{mode:'all'})[0]),art=id=>store.get('SELECT art_provider FROM versions WHERE id=?',id).art_provider;
 assert.equal(art(generated),'grok-cli');assert.equal(store.deck(deck.id).cards[0].art_provider,'grok-cli');
 store.updateCard(card.id,{image_provider:''});const recomposed=complete(queue.enqueue(deck.id,{mode:'selected',card_ids:[card.id],type:'compose'})[0]);assert.equal(art(recomposed),'grok-cli');
 const regenerated=complete(queue.enqueue(deck.id,{mode:'selected',card_ids:[card.id]})[0]);assert.equal(art(regenerated),'codex');
 const copy=store.duplicate(deck.id);assert.equal(copy.cards[0].art_provider,'codex');
 assert.deepEqual(store.versions(card.id).map(v=>v.art_provider),['codex','grok-cli','grok-cli']);
 queue.close();store.close();const db=new DatabaseSync(path.join(dir,'studio.sqlite'));db.exec('ALTER TABLE versions DROP COLUMN art_provider');db.close();
 store=new Store(dir,{recover:false});assert.deepEqual(store.versions(card.id).map(v=>v.art_provider),['codex','grok-cli','grok-cli']);assert.equal(store.deck(copy.id).cards[0].art_provider,'codex');
});
