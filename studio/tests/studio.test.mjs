import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {createStudio} from '../server.mjs';
import {Store} from '../store.mjs';
const fixture=fileURLToPath(new URL('./fixtures/fake-codex.py',import.meta.url));
fs.chmodSync(fixture,0o755);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){const value=fn();if(value)return value;await delay(40);}throw new Error('Timed out waiting for queue.');}
async function setup(t,extra={}){
  const {metadataFetcher,officialFetcher,...runnerOptions}=extra;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-test-'));
  const app=createStudio({library:dir,seed:false,status:{installed:true,signed_in:true,version:'Fixture'},metadataFetcher,officialFetcher:officialFetcher||(async()=>{throw Error('Fixture printing service unavailable');}),runner:{binary:fixture,...runnerOptions}});
  // Exercise the real request listener without opening a socket. Also works in restricted CI.
  const url='http://127.0.0.1:4317';
  const fetchLocal=(address,options={})=>new Promise((resolve,reject)=>{
    const parsed=new URL(address),req=Readable.from(options.body?[Buffer.from(options.body)]:[]);
    req.url=parsed.pathname+parsed.search;req.method=options.method||'GET';req.headers={host:parsed.host};
    for(const [key,value]of Object.entries(options.headers||{}))req.headers[key.toLowerCase()]=value;
    const chunks=[],headers={};
    const res=new Writable({write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));callback();}});
    res.statusCode=200;res.headersSent=false;res.setHeader=(key,value)=>{headers[key]=value;};
    res.writeHead=(code,values)=>{res.statusCode=code;Object.assign(headers,values);res.headersSent=true;};
    res.on('error',reject);res.on('finish',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers})));
    app.server.emit('request',req,res);
  });
  const bootstrap=await(await fetchLocal(url+'/api/bootstrap')).json();
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(route,method='GET',data,headers={})=>{
    const response=await fetchLocal(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':bootstrap.token,...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    return {status:response.status,data:await response.json()};
  };return {app,url,request,dir,fetchLocal};
}

test('HTTP deck import, isolation, organisation, persistence, and local request protection',async t=>{
  const {app,url,request,dir,fetchLocal}=await setup(t);
  const a=await request('/api/decks','POST',{name:'First world',folder:'Commander',style:'Blue woodland',decklist:'Commander\n1 Rin and Seri, Inseparable\nDeck\n1 Sol Ring\n8 Forest'});
  const b=await request('/api/decks','POST',{name:'Second world',decklist:'1 Sol Ring'});
  assert.equal(a.status,201);assert.equal(a.data.cards.length,3);assert.notEqual(a.data.cards[1].id,b.data.cards[0].id);
  const bad=await request('/api/decks','POST',{name:'Invalid',decklist:'1 Sol Ring\n0 Forest'});assert.equal(bad.status,400);assert.equal(app.store.listDecks().length,2);
  const foreign=await request(`/api/decks/${a.data.id}/generate`,'POST',{mode:'selected',card_ids:[b.data.cards[0].id]});assert.equal(foreign.status,400);
  await request('/api/decks/'+a.data.id,'PATCH',{folder:'Favourites',archived:true});
  assert.equal(app.store.deck(a.data.id).folder,'Favourites');assert.equal(app.store.deck(a.data.id).archived,1);
  assert.equal((await request(`/api/decks/${a.data.id}/generate`,'POST',{})).status,400);
  const duplicate=await request(`/api/decks/${a.data.id}/duplicate`,'POST',{});assert.equal(duplicate.data.cards.length,3);assert.equal(duplicate.data.archived,0);
  const list=await fetchLocal(`${url}/api/decks/${a.data.id}/decklist.txt`);assert.match(await list.text(),/8 Forest/);
  assert.equal((await request('/api/decks','POST',{name:'Nope'},{'X-Studio-Token':'wrong'})).status,403);
  assert.equal((await request('/api/decks','POST',{name:'Nope'},{Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await request('/api/bootstrap','GET',undefined,{Host:'attacker.example'})).status,403);
  const append=await request(`/api/decks/${b.data.id}/cards`,'POST',{decklist:'1 Forest\n999 Sol Ring',deduplicate:false});assert.equal(append.status,400);assert.equal(app.store.deck(b.data.id).cards.length,1);
  // Independent SQLite reader verifies committed on-disk state, without restart recovery.
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dir,'studio.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decks').get().n,3);db.close();
});

test('Codex JSONL → saved manifest → real Python composition → review, revision, rollback and export',async t=>{
  const {app,url,request,fetchLocal}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Renderer roundtrip',style:'A saved deck-specific style.',decklist:'1 Sol Ring'})).data;
  const card=deck.cards[0];const launched=await request(`/api/decks/${deck.id}/generate`,'POST',{});assert.equal(launched.data.queued,1);
  const job=await until(()=>{const j=app.store.jobs(deck.id)[0];return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(job.status,'succeeded',job.error);
  assert.equal(job.thread_id,'fixture-thread',fs.readFileSync(path.join(job.directory,'events.jsonl'),'utf8'));const first=app.store.versions(card.id)[0];
  assert.equal(fs.readFileSync(first.image_path).subarray(1,4).toString(),'PNG');assert.ok(fs.existsSync(first.frame_path));
  assert.equal(fs.readFileSync(path.join(job.directory,'style.txt'),'utf8'),'A saved deck-specific style.');
  assert.ok(app.store.events(job.id).some(e=>e.kind==='succeeded'));
  const fullList=await request(`/api/decks/${deck.id}/cards`,'POST',{decklist:'1 x sol ring',deduplicate:true});
  assert.equal(fullList.data.skipped,1);assert.equal(fullList.data.added,0);
  assert.equal(app.store.deck(deck.id).cards[0].quantity,1);assert.equal(app.store.deck(deck.id).cards[0].active_version_id,first.id);assert.equal(app.store.versions(card.id).length,1);
  assert.equal((await request(`/api/decks/${deck.id}/generate`,'POST',{})).data.queued,0);
  await request('/api/cards/'+card.id,'PATCH',{approval:'approved',quantity:2,notes:'Keep this warm.'});
  const revision=await request(`/api/cards/${card.id}/revise`,'POST',{instructions:'Change the title, preserving all gameplay.'});assert.equal(revision.data.queued,1);
  assert.equal(app.store.deck(deck.id).cards[0].active_version_id,first.id);
  const revised=await until(()=>{const j=app.store.get('SELECT * FROM jobs WHERE id=?',revision.data.jobs[0]);return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(revised.status,'succeeded',revised.error);
  const versions=app.store.versions(card.id);assert.equal(versions.length,2);assert.equal(versions[0].summary.display_name,'Revised Hearthstone');assert.ok(fs.existsSync(first.image_path));
  await request('/api/queue','POST',{paused:true});
  const reused=(await request('/api/decks','POST',{name:'Reuse across decks',decklist:'1 x Sol Ring',deduplicate:true})).data;
  assert.equal(reused.queued,0);assert.equal(reused.cards[0].active_version_id,null);
  const candidates=(await request('/api/cards/'+reused.cards[0].id+'/artwork-sources')).data;assert.ok(candidates.some(c=>c.id===versions[0].id));
  const selected=await request('/api/cards/'+reused.cards[0].id+'/reuse-artwork','POST',{source_version_id:versions[0].id});assert.equal(selected.status,201,selected.data.error);
  const selectedVersion=app.store.versions(reused.cards[0].id)[0];assert.notEqual(selectedVersion.id,versions[0].id);assert.notEqual(selectedVersion.manifest_path,versions[0].manifest_path);assert.equal(selectedVersion.summary.name,'Sol Ring');assert.equal(selectedVersion.summary.display_name,undefined);assert.match(selectedVersion.note,/Selected artwork/);
  assert.equal(app.store.deck(deck.id).cards[0].summary.display_name,'Revised Hearthstone');
  const fresh=(await request('/api/decks','POST',{name:'A different art style',decklist:'1 Sol Ring',deduplicate:false})).data;
  assert.equal(fresh.cards[0].active_version_id,null);
  const increased=await request(`/api/decks/${deck.id}/cards`,'POST',{decklist:'1 Sol Ring',deduplicate:false});assert.equal(increased.data.updated,1);assert.equal(app.store.deck(deck.id).cards[0].quantity,3);
  await request('/api/queue','POST',{paused:false});
  const savedRequest=JSON.parse(fs.readFileSync(path.join(revised.directory,'request.json')));assert.equal(savedRequest.previous_version.id,first.id);assert.equal(savedRequest.instructions,'Change the title, preserving all gameplay.');
  await request(`/api/versions/${first.id}/activate`,'POST',{});assert.equal(app.store.deck(deck.id).cards[0].active_version_id,first.id);
  const copied=(await request(`/api/decks/${deck.id}/duplicate`,'POST',{})).data;assert.notEqual(copied.cards[0].active_version_id,first.id);assert.equal(copied.cards[0].summary.display_name,'The Hearthstone');
  assert.equal((await fetchLocal(`${url}/assets/${first.id}/image`)).status,200);
  const zip=await fetchLocal(`${url}/api/decks/${deck.id}/export.zip`);assert.equal(zip.status,200);assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0,2).toString(),'PK');
  assert.equal((await request('/assets/not-a-version/image')).status,404);
});

test('queue pause, deduplication, cancellation, blocked failures and retry',async t=>{
  const {app,request}=await setup(t);
  await request('/api/queue','POST',{paused:true});
  const deck=(await request('/api/decks','POST',{name:'Queue control',decklist:'1 Slow Card\n1 Blocked Card',generate:true})).data;
  assert.equal(deck.queued,2);assert.ok(app.store.jobs(deck.id).every(j=>j.status==='queued'));
  const queuedRequest=app.store.jobs(deck.id)[0];
  assert.equal(fs.readFileSync(path.join(queuedRequest.directory,'style.txt'),'utf8'),fs.readFileSync(new URL('../default-style.txt',import.meta.url),'utf8'));
  assert.equal((await request(`/api/decks/${deck.id}/generate`,'POST',{})).data.queued,0);
  const slow=app.store.jobs(deck.id).find(j=>j.card_name==='Slow Card');await request(`/api/jobs/${slow.id}/cancel`,'POST',{});
  assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',slow.id).status,'cancelled');
  await request('/api/queue','POST',{paused:false});
  const failed=await until(()=>app.store.jobs(deck.id).find(j=>j.card_name==='Blocked Card'&&j.status==='failed'));assert.match(failed.error,/Image generation unavailable/);
  await request('/api/queue','POST',{paused:true});const retried=await request(`/api/jobs/${failed.id}/retry`,'POST',{});assert.equal(retried.data.jobs.length,1);
  const started=await request(`/api/jobs/${slow.id}/retry`,'POST',{});await request(`/api/jobs/${retried.data.jobs[0]}/cancel`,'POST',{});await request('/api/queue','POST',{paused:false});
  await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',started.data.jobs[0]).status==='running');
  await request(`/api/jobs/${started.data.jobs[0]}/cancel`,'POST',{});await until(()=>!app.queue.active);assert.equal(app.store.versions(slow.card_id).length,0);
});

test('interrupted jobs recover as retryable failures; queued work survives restart',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-restart-'));let store=new Store(directory);
  try{const deck=store.createDeck({name:'Recovery'},[{name:'Sol Ring',quantity:1,section:'main'}]);
    for(const status of ['running','queued'])store.run('INSERT INTO jobs(id,deck_id,card_id,type,status,version_id,directory,created_at) VALUES(?,?,?,?,?,?,?,?)',status,deck.id,deck.cards[0].id,'generate',status,status,directory,new Date().toISOString());
    store.close();store=new Store(directory);assert.equal(store.get("SELECT status FROM jobs WHERE id='running'").status,'failed');assert.equal(store.get("SELECT status FROM jobs WHERE id='queued'").status,'queued');
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('per-card controls compose new versions locally, restore base values and retain historical guidelines',async t=>{
  const {app,request}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Appearance workshop',style:'Original blue brief.',decklist:'1 Sol Ring',generate:true})).data;
  const card=deck.cards[0];
  await until(()=>app.store.jobs(deck.id)[0].status==='succeeded');const first=app.store.versions(card.id)[0];
  assert.equal(first.style_text,'Original blue brief.');
  await request('/api/decks/'+deck.id,'PATCH',{style:'Now a different red brief.'});
  const invalid=await request('/api/cards/'+card.id+'/customize','POST',{customization:{title_mode:'custom',display_name:''}});assert.equal(invalid.status,400);
  const custom={title_mode:'custom',display_name:'A Personal Title',flavor_mode:'custom',flavor_text:'Made for this adventure.',rarity:'mythic',art_focus:[.25,.75]};
  const update=await request('/api/cards/'+card.id+'/customize','POST',{customization:custom,apply:true});assert.equal(update.data.queued,1);
  const composed=await until(()=>{const j=app.store.get('SELECT * FROM jobs WHERE id=?',update.data.jobs[0]);return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(composed.status,'succeeded',composed.error);assert.equal(composed.thread_id,null);
  const second=app.store.versions(card.id)[0];assert.equal(second.number,2);assert.equal(second.style_text,'Original blue brief.');assert.equal(second.summary.display_name,custom.display_name);assert.equal(second.summary.flavor_text,custom.flavor_text);assert.equal(second.summary.rarity,'mythic');assert.deepEqual(second.summary.art_focus,[.25,.75]);assert.equal(second.summary.oracle_text,first.summary.oracle_text);
  const original=await request('/api/cards/'+card.id+'/customize','POST',{customization:{title_mode:'original',flavor_mode:'none',rarity:'original'},apply:true});
  await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',original.data.jobs[0]).status==='succeeded');const third=app.store.versions(card.id)[0];assert.equal(third.number,3);assert.equal(third.summary.display_name,undefined);assert.equal(third.summary.flavor_text,undefined);assert.equal(third.summary.rarity,'uncommon');
  await request('/api/versions/'+first.id+'/activate','POST',{});assert.equal(app.store.deck(deck.id).cards[0].active_version_id,first.id);assert.equal(app.store.versions(card.id).length,3);
  assert.deepEqual(app.store.deck(deck.id).cards[0].customization,{});
  const duplicate=(await request('/api/decks/'+deck.id+'/duplicate','POST',{})).data;assert.deepEqual(duplicate.cards[0].customization,{});assert.equal(app.store.versions(duplicate.cards[0].id)[0].style_text,first.style_text);
});

test('metadata lookup analyses unillustrated cards, caches results and preserves artwork history',async t=>{
  let calls=0;
  const {app,request}=await setup(t,{metadataFetcher:async(url,options)=>{
    calls++;assert.equal(url,'https://api.scryfall.com/cards/collection');const identifiers=JSON.parse(options.body).identifiers;
    return new Response(JSON.stringify({data:identifiers.filter(c=>c.name!=='Unknown Card').map(c=>({id:'metadata-'+c.name,name:c.name,type_line:c.name==='Forest'?'Basic Land — Forest':'Artifact',mana_cost:c.name==='Forest'?'':'{1}',cmc:c.name==='Forest'?0:1,oracle_text:'',color_identity:[],produced_mana:c.name==='Forest'?['G']:[],legalities:{commander:'legal'}}))}),{status:200});
  }});
  const deck=(await request('/api/decks','POST',{name:'Builder first',decklist:'1 Sol Ring\n10 Forest\n1 Unknown Card'})).data;
  const resolved=await request(`/api/decks/${deck.id}/resolve`,'POST',{});assert.equal(resolved.data.resolved,2);assert.deepEqual(resolved.data.missing,['Unknown Card']);
  assert.equal(app.store.deck(deck.id).cards[0].metadata.type_line,'Artifact');assert.equal(app.store.jobs().length,0);assert.equal(app.store.versions(deck.cards[0].id).length,0);
  const next=(await request('/api/decks','POST',{name:'Cached deck',decklist:'1 Sol Ring'})).data;
  await request(`/api/decks/${next.id}/resolve`,'POST',{});assert.equal(calls,1);
  await request('/api/cards/'+next.cards[0].id,'PATCH',{quantity:3,roles:['Ramp','Draw']});assert.deepEqual(app.store.deck(next.id).cards[0].roles,['ramp','draw']);
});

test('print export expands quantities, reports missing art and produces exact-size multi-page PDFs',async t=>{
  const {app,url,request,fetchLocal}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Print ready',decklist:'2 Sol Ring',generate:true})).data;
  await until(()=>app.store.jobs(deck.id)[0].status==='succeeded');
  const preview=await request(`/api/decks/${deck.id}/print-preview`,'POST',{paper:'A4',calibration:true});assert.equal(preview.data.count,2);assert.equal(preview.data.per_page,9);assert.equal(preview.data.pages,1);
  const bootstrap=await(await fetchLocal(url+'/api/bootstrap')).json();
  const response=await fetchLocal(`${url}/api/decks/${deck.id}/print.pdf`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':bootstrap.token},body:JSON.stringify({paper:'A4',calibration:true,quality:'compact'})});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');const pdf=Buffer.from(await response.arrayBuffer()).toString('latin1');assert.ok(pdf.startsWith('%PDF-'));assert.equal((pdf.match(/\/Type\s*\/Page\b/g)||[]).length,2);assert.match(pdf,/595\.2756 841\.8898/);
  await request(`/api/decks/${deck.id}/cards`,'POST',{decklist:'1 Not Generated'});
  assert.equal((await request(`/api/decks/${deck.id}/print.pdf`,'POST',{})).status,400);
  assert.equal((await request(`/api/decks/${deck.id}/print-preview`,'POST',{quantities:false})).data.count,1);
});

test('fresh illustrations are checked against cards finished after the batch was queued',async t=>{
  const {app,request}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Composition gate',decklist:'1 Sol Ring\n1 Arcane Signet',generate:true})).data;
  await until(()=>app.store.jobs(deck.id).every(j=>['succeeded','failed'].includes(j.status)));
  const jobs=app.store.jobs(deck.id);assert.equal(jobs.filter(j=>j.status==='succeeded').length,1);
  const failed=jobs.find(j=>j.status==='failed');assert.match(failed.error,/Composition is too similar/);
  const requestData=JSON.parse(fs.readFileSync(path.join(failed.directory,'request.json')));assert.equal(requestData.deck.art_references.length,1);assert.ok(requestData.deck.art_references[0].scene.shot_distance);
  assert.equal(app.store.versions(failed.card_id).length,0);
});

test('unique token and land variants preserve mechanics, quantities, histories and de-duplication',async t=>{
  const {app,request}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Variant workshop',decklist:'8 Forest'})).data;
  const land=await request(`/api/decks/${deck.id}/variants`,'POST',{kind:'land',name:'Forest',variants:3,total_copies:8,replace_existing:true});assert.equal(land.status,201);
  let cards=app.store.deck(deck.id).cards;assert.equal(cards.length,3);assert.deepEqual(cards.map(c=>c.quantity),[3,3,2]);assert.equal(cards[0].id,deck.cards[0].id);assert.equal(new Set(cards.map(c=>c.variant_group)).size,1);
  await request(`/api/decks/${deck.id}/cards`,'POST',{decklist:'8 x Forest',deduplicate:true});assert.equal(app.store.deck(deck.id).cards.reduce((n,c)=>n+c.quantity,0),8);
  const spec={type_line:'Token Creature — Cat',colors:['G'],power:'1',toughness:'1',oracle_text:''};
  const token=await request(`/api/decks/${deck.id}/variants`,'POST',{kind:'token',name:'Cat',variants:2,total_copies:4,token_spec:spec,generate:true});assert.equal(token.status,201);assert.equal(token.data.queued,2);
  await until(()=>app.store.jobs(deck.id).every(j=>['succeeded','failed'].includes(j.status)));
  assert.ok(app.store.jobs(deck.id).every(j=>j.status==='succeeded'),JSON.stringify(app.store.jobs(deck.id).map(j=>j.error)));
  const tokens=app.store.deck(deck.id).cards.filter(c=>c.section==='tokens');assert.equal(tokens.length,2);assert.equal(tokens[0].quantity,2);assert.equal(tokens[0].summary.name,'Cat');assert.equal(tokens[0].summary.layout,'token');assert.equal(tokens[0].summary.mana_cost,'');assert.equal(tokens[0].summary.type_line,spec.type_line);assert.equal(tokens[0].summary.power,'1');assert.deepEqual(tokens[0].summary.colors,['G']);
  assert.notEqual(app.store.versions(tokens[0].id)[0].image_path,app.store.versions(tokens[1].id)[0].image_path);
  const reports=tokens.map(c=>JSON.parse(fs.readFileSync(app.store.versions(c.id)[0].report_path)));assert.notEqual(reports[0].art_pixels_sha256,reports[1].art_pixels_sha256);
  assert.equal(app.store.listDecks().find(d=>d.id===deck.id).total_cards,8);
  const {analyzeDeck}=await import('../public/analysis.js');assert.equal(analyzeDeck(app.store.deck(deck.id).cards).tokens,4);assert.equal(analyzeDeck(app.store.deck(deck.id).cards).types.Creature,0);
  assert.equal((await request(`/api/decks/${deck.id}/print-preview`,'POST',{include_tokens:false})).data.count,0);assert.equal((await request(`/api/decks/${deck.id}/print-preview`,'POST',{include_tokens:true})).data.count,4);
  const duplicate=(await request(`/api/decks/${deck.id}/duplicate`,'POST',{})).data;assert.equal(duplicate.cards.length,5);assert.equal(duplicate.cards.filter(c=>c.entry_kind==='token').length,2);
});

test('parallel workers honour limits and automatically refill a freed slot',async t=>{
  const {app,request}=await setup(t);await request('/api/queue','POST',{paused:true,concurrency:2});
  const deck=(await request('/api/decks','POST',{name:'Parallel test',decklist:'1 Slow Card One\n1 Slow Card Two\n1 Slow Card Three',generate:true})).data;
  await request('/api/queue','POST',{paused:false});await until(()=>app.queue.activeJobs.size===2);assert.equal(app.store.jobs(deck.id).filter(j=>j.status==='running').length,2);
  const active=app.store.jobs(deck.id).filter(j=>j.status==='running'),waiting=app.store.jobs(deck.id).find(j=>j.status==='queued');
  await request('/api/jobs/'+active[0].id+'/cancel','POST',{});await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',waiting.id).status==='running');
  assert.equal(app.queue.activeJobs.size,2);assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',active[1].id).status,'running');
  assert.equal((await request('/api/queue','POST',{concurrency:5})).status,400);
});

test('rate-limited jobs recover automatically and keep prior attempt files',async t=>{
  const {app,request}=await setup(t,{retryBaseMs:50});
  const deck=(await request('/api/decks','POST',{name:'Recoverable limit',decklist:'1 Rate Limited Card',generate:true})).data;
  const result=await until(()=>{const job=app.store.jobs(deck.id)[0];return ['succeeded','failed'].includes(job.status)&&job;});
  assert.equal(result.status,'succeeded',result.error);assert.equal(result.retry_count,1);assert.match(result.directory,/attempt-2$/);assert.equal(result.error,null);
  assert.ok(fs.existsSync(path.join(path.dirname(result.directory),'events.jsonl')));assert.ok(app.store.events(result.id).some(e=>e.kind==='rate_limited'));
});

test('automatic recovery stops at its configured retry cap',async t=>{
  const {app,request}=await setup(t,{retryBaseMs:10,maxRateRetries:2});
  const deck=(await request('/api/decks','POST',{name:'Persistent limit',decklist:'1 Rate Limited Forever',generate:true})).data;
  const job=await until(()=>app.store.jobs(deck.id).find(j=>j.status==='failed'));assert.equal(job.retry_count,2);assert.match(job.error,/retry limit reached/);
});

test('double-faced cards retain both sides through composition, assets, history and print export',async t=>{
  const {app,url,request,fetchLocal}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Both sides',decklist:'1 Fixture Transform',generate:true})).data;
  const job=await until(()=>{const j=app.store.jobs(deck.id)[0];return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(job.status,'succeeded',job.error);
  const version=app.store.versions(deck.cards[0].id)[0];assert.equal(version.faces.length,2);assert.ok(fs.existsSync(version.faces[1].image_path));
  assert.equal((await fetchLocal(`${url}/assets/${version.id}/back-image`)).status,200);
  const preview=await request(`/api/decks/${deck.id}/print-preview`,'POST',{face_mode:'duplex'});assert.equal(preview.data.pages,2);
  const boot=await(await fetchLocal(url+'/api/bootstrap')).json();
  const printed=await fetchLocal(`${url}/api/decks/${deck.id}/print.pdf`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:JSON.stringify({face_mode:'duplex',quality:'compact'})});
  assert.equal(printed.status,200);assert.equal((Buffer.from(await printed.arrayBuffer()).toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,2);
  const updated=await request('/api/cards/'+deck.cards[0].id+'/customize','POST',{customization:{title_mode:'style',back:{title_mode:'custom',display_name:'The Ascended One',flavor_mode:'none'}},apply:true});
  const result=await until(()=>{const j=app.store.get('SELECT * FROM jobs WHERE id=?',updated.data.jobs[0]);return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(result.status,'succeeded',result.error);
  const next=app.store.versions(deck.cards[0].id)[0];assert.equal(next.summary.faces[1].display_name,'The Ascended One');assert.equal(next.summary.faces[0].display_name,undefined);assert.equal(next.faces.length,2);
});

test('agent-generated frame sets validate all required layouts before deck selection and rendering',async t=>{
  const {app,request}=await setup(t);
  const created=await request('/api/frame-sets','POST',{name:'Brass Test Set',brief:'Angular brass borders and dark high-contrast panels.',controls:{rail_material:'copper',border_mode:'bordered',rules_sizing:'fit',title_padding:35}});assert.equal(created.status,201);
  const setId=created.data.id;
  const deck=(await request('/api/decks','POST',{name:'Frame selection',decklist:'1 Sol Ring'})).data;
  assert.equal((await request('/api/decks/'+deck.id,'PATCH',{frame_set_id:setId})).status,400);
  const ready=await until(()=>{const detail=app.frames.detail(setId);return ['ready','failed'].includes(detail.versions[0].status)&&detail;},90000);
  assert.equal(ready.versions[0].status,'ready',ready.versions[0].error);assert.equal(ready.layouts.length,13);
  const config=JSON.parse(fs.readFileSync(ready.versions[0].config_path));assert.equal(config.style.rail_color,'#B97842');assert.equal(config.style.border_mode,'bordered');assert.equal(config.style.title_padding,35);
  const validation=JSON.parse(fs.readFileSync(path.join(ready.versions[0].directory,'previews/validation.json')));assert.equal(validation.colour_variants.length,34);
  assert.equal((await request('/api/frame-sets/'+setId,'PATCH',{name:'Renamed Brass'})).data.name,'Renamed Brass');
  assert.equal((await request('/api/frame-sets/'+setId+'/default','POST',{})).status,200);
  const newDeck=(await request('/api/decks','POST',{name:'Default frames',decklist:''})).data;assert.equal(newDeck.frame_set_id,setId);assert.equal(app.store.deck(deck.id).frame_set_id,'builtin-v2.4');
  assert.equal((await request('/api/decks/'+deck.id,'PATCH',{frame_set_id:setId})).status,200);
  await request(`/api/decks/${deck.id}/generate`,'POST',{});
  const job=await until(()=>{const j=app.store.jobs(deck.id)[0];return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(job.status,'succeeded',job.error);
  const version=app.store.versions(deck.cards[0].id)[0];assert.equal(version.summary.frame_style.name,'Brass Test Set');
  assert.equal(JSON.parse(fs.readFileSync(version.report_path)).frame_set,'Brass Test Set');
  const snapshot=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json')));assert.equal(snapshot.frame_set.version_id,ready.current_version_id);assert.ok(snapshot.frame_set.config_path.startsWith(job.directory));
  const context={layout:'creature',family:'U',legendary:true,alias:true},controls={rail_material:'copper',border_mode:'bordered',rules_sizing:'full',title_padding:45,type_padding:40,alias_padding:25,title_offset_y:30,rules_offset_y:60,stats_x:920,stats_y:1920,stats_width:400,stats_height:130};
  const proof=await request('/api/frame-sets/'+setId+'/preview','POST',{version_id:ready.current_version_id,controls,context});assert.equal(proof.status,200,proof.data.error);assert.match(proof.data.image,/^data:image\/png;base64,/);assert.equal((proof.data.geometry.title[1]+proof.data.geometry.title[3])/2,150);assert.ok(proof.data.geometry.art[0]>0);assert.deepEqual(proof.data.geometry.stats,[920,1920,1320,2050]);
  const visual_edits={source_version_id:ready.current_version_id,context,annotations:[{id:'corner',rect:[.02,.15,.2,.1],note:'Replace this corner with a copper leaf ornament.',...context}]};
  const invalid={...visual_edits,annotations:[{...visual_edits.annotations[0],rect:[.9,.9,.3,.2]}]};assert.equal((await request('/api/frame-sets/'+setId,'PATCH',{visual_edits:invalid})).status,400);
  const revised=await request('/api/frame-sets/'+setId+'/generate','POST',{controls,visual_edits});assert.equal(revised.status,202,revised.data.error);
  const done=await until(()=>{const d=app.frames.detail(setId);return ['ready','failed'].includes(d.versions[0].status)&&d;},120000);assert.equal(done.versions[0].status,'ready',done.versions[0].error);
  const frozen=JSON.parse(fs.readFileSync(path.join(done.versions[0].directory,'request.json')));assert.equal(frozen.previous.version_id,ready.current_version_id);assert.equal(frozen.visual_edits.annotations[0].note,visual_edits.annotations[0].note);assert.ok(fs.existsSync(frozen.review_images[0].path));assert.ok(fs.existsSync(path.join(done.versions[0].directory,'visual-edits.json')));assert.equal(JSON.parse(fs.readFileSync(done.versions[0].config_path)).style.title_offset_y,30);assert.equal(JSON.parse(fs.readFileSync(done.versions[0].config_path)).style.stats_width,400);

  // Deleting the default set moves its decks to the included frame; the included frame cannot be deleted.
  const removed=await request('/api/frame-sets/'+setId,'DELETE');assert.equal(removed.status,200,removed.data.error);assert.equal(removed.data.fallback,'builtin-v2.4');assert.ok(removed.data.decks>=2);
  assert.equal(app.store.deck(deck.id).frame_set_id,'builtin-v2.4');assert.equal(app.frames.defaultId(),'builtin-v2.4');assert.ok(!app.frames.list().some(s=>s.id===setId));
  assert.ok(fs.existsSync(done.versions[0].directory));assert.equal((await request('/api/frame-sets/builtin-v2.4','DELETE')).status,400);
});

test('three frame options span simpler, the brief and more flavour, and the user picks one',async t=>{
  const {app,request}=await setup(t);
  const created=await request('/api/frame-sets','POST',{name:'Three Ways',brief:'A themed frame.',brief_fields:{motif:'Stars',avoid:'Plain gold'},options:3,controls:{flavour_level:'stylised'}});assert.equal(created.status,201,created.data.error);
  const setId=created.data.id;assert.deepEqual(app.frames.detail(setId).brief_fields,{motif:'Stars',avoid:'Plain gold'});
  const done=await until(()=>{const d=app.frames.detail(setId);return d.versions.length===3&&d.versions.every(v=>['ready','failed'].includes(v.status))&&d;},240000);
  const by=Object.fromEntries(done.versions.map(v=>[v.candidate_direction,v]));assert.deepEqual(Object.keys(by).sort(),['prompt','richer','simpler']);
  for(const v of done.versions)assert.equal(v.status,'ready',v.error);
  assert.equal(new Set(done.versions.map(v=>v.candidate_group)).size,1);
  const targets=Object.fromEntries(Object.entries(by).map(([k,v])=>[k,JSON.parse(fs.readFileSync(path.join(v.directory,'request.json'))).candidate.target]));assert.deepEqual(targets,{simpler:'classic',prompt:'stylised',richer:'showcase'});
  assert.equal(by.prompt.concept.flavour_level,'stylised');assert.equal(by.richer.concept.review.flavour_level,'showcase');assert.ok(by.prompt.concept.review.real_art_count>=0);
  assert.equal(done.current_version_id,by.prompt.id);
  const req=JSON.parse(fs.readFileSync(path.join(by.prompt.directory,'request.json')));assert.equal(req.brief_fields.motif,'Stars');assert.equal(req.design_process,2);assert.match(req.candidate.instructions,/MIDDLE/);
  assert.equal((await request('/api/frame-sets/'+by.simpler.id+'/activate','POST',{})).status,200);
  const picked=app.frames.detail(setId);assert.equal(picked.current_version_id,by.simpler.id);assert.equal(picked.picked_group,by.simpler.candidate_group);
  assert.equal((await request('/api/frame-sets/'+setId+'/generate','POST',{options:2})).status,400);
});

test('model capacity retries use the protocol failure instead of an unrelated stderr image warning',async t=>{
 const {app,request}=await setup(t,{retryBaseMs:20});const deck=(await request('/api/decks','POST',{name:'Capacity recovery',decklist:'1 Capacity Once',generate:true})).data;
 const job=await until(()=>{const j=app.store.jobs(deck.id)[0];return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(job.status,'succeeded',job.error);assert.equal(job.retry_count,1);assert.ok(app.store.events(job.id).some(e=>e.kind==='rate_limited'));
});

test('imports de-duplicate only within their own deck and never infer artwork reuse',async t=>{
 const {app,request}=await setup(t),a=(await request('/api/decks','POST',{name:'Source deck',decklist:'1 Sol Ring',generate:true})).data;
 await until(()=>app.store.jobs(a.id)[0]?.status==='succeeded');
 const b=(await request('/api/decks','POST',{name:'Independent art',decklist:'1 Sol Ring',deduplicate:true})).data;assert.equal(b.cards[0].active_version_id,null);assert.equal(app.store.versions(b.cards[0].id).length,0);
 const duplicate=await request('/api/decks/'+b.id+'/cards','POST',{decklist:'1 x Sol Ring',deduplicate:true});assert.equal(duplicate.data.skipped,1);assert.equal(duplicate.data.reused,0);assert.equal(app.store.deck(b.id).cards[0].active_version_id,null);
 await request('/api/decks/'+b.id+'/cards','POST',{decklist:'1 Arcane Signet',deduplicate:false});
 const wrong=await request('/api/cards/'+app.store.deck(b.id).cards.find(c=>c.name==='Arcane Signet').id+'/reuse-artwork','POST',{source_version_id:app.store.deck(a.id).cards[0].active_version_id});assert.equal(wrong.status,400);
 const generated=await request('/api/decks/'+b.id+'/generate','POST',{mode:'selected',card_ids:[b.cards[0].id]});assert.equal(generated.data.queued,1);await until(()=>app.store.jobs(b.id)[0]?.status==='succeeded');assert.notEqual(app.store.deck(a.id).cards[0].active_version_id,app.store.deck(b.id).cards[0].active_version_id);
});

test('clearing old automatic artwork unselects only inherited versions and keeps history',async t=>{
 const {app,request}=await setup(t),source=(await request('/api/decks','POST',{name:'Legacy source',decklist:'1 Sol Ring',generate:true})).data;
 await until(()=>app.store.jobs(source.id)[0]?.status==='succeeded');const v=app.store.versions(source.cards[0].id)[0],target=(await request('/api/decks','POST',{name:'Legacy imported deck',decklist:'1 Sol Ring'})).data;
 app.store.addVersion(target.cards[0].id,{...v,id:undefined,job_id:null,note:'Reused from Legacy source'});
 assert.ok(app.store.deck(target.id).cards[0].active_version_id);const cleared=await request('/api/decks/'+target.id+'/clear-automatic-artwork','POST',{});assert.equal(cleared.data.cleared,1);assert.equal(app.store.deck(target.id).cards[0].active_version_id,null);assert.equal(app.store.versions(target.cards[0].id).length,1);assert.ok(app.store.deck(source.id).cards[0].active_version_id);
});

test('explicit artwork reuse keeps destination controls and both faces of double-faced cards',async t=>{
 const {app,request}=await setup(t),source=(await request('/api/decks','POST',{name:'Paired artwork source',decklist:'1 Fixture Transform',generate:true})).data;
 await until(()=>app.store.jobs(source.id)[0]?.status==='succeeded');const sourceVersion=app.store.versions(source.cards[0].id)[0],target=(await request('/api/decks','POST',{name:'Independent paired deck',decklist:'1 Fixture Transform'})).data,card=target.cards[0];
 await request('/api/cards/'+card.id,'PATCH',{quantity:3,notes:'Keep my own notes',customization:{title_mode:'custom',display_name:'Destination front',flavor_mode:'none',back:{title_mode:'custom',display_name:'Destination back',flavor_mode:'none'}}});
 const result=await request('/api/cards/'+card.id+'/reuse-artwork','POST',{source_version_id:sourceVersion.id});assert.equal(result.status,201,result.data.error);const version=app.store.versions(card.id)[0];assert.equal(version.faces.length,2);assert.equal(version.summary.faces[0].display_name,'Destination front');assert.equal(version.summary.faces[1].display_name,'Destination back');assert.ok(fs.existsSync(version.faces[1].image_path));assert.equal(app.store.deck(target.id).cards[0].quantity,3);assert.equal(app.store.deck(target.id).cards[0].notes,'Keep my own notes');assert.notEqual(version.summary.faces[0].art,sourceVersion.summary.faces[0].art);assert.equal(app.store.versions(source.cards[0].id)[0].summary.faces[0].display_name,undefined);
});

test('double-faced lookup uses the front name and preserves the full paired metadata',async t=>{
 const snapshot=JSON.parse(fs.readFileSync(path.join(process.cwd(),'data/bala-ged-recovery.scryfall.json')));let collectionCalls=0,namedCalls=0;
 const {app,request}=await setup(t,{metadataFetcher:async(url,options)=>{if(url.endsWith('/collection')){collectionCalls++;assert.equal(JSON.parse(options.body).identifiers[0].name,'Bala Ged Recovery');return new Response(JSON.stringify({data:[],not_found:[{name:'Bala Ged Recovery'}]}));}namedCalls++;assert.equal(new URL(url).searchParams.get('exact'),'Bala Ged Recovery');return new Response(JSON.stringify(snapshot));}});
 const deck=(await request('/api/decks','POST',{name:'Modal DFC',decklist:'1 Bala Ged Recovery // Bala Ged Sanctuary'})).data;const result=await request('/api/decks/'+deck.id+'/resolve','POST',{});assert.equal(result.data.resolved,1);assert.deepEqual(result.data.missing,[]);const card=app.store.deck(deck.id).cards[0];assert.equal(card.metadata.layout,'modal_dfc');assert.equal(card.metadata.card_faces.length,2);assert.equal(card.metadata.card_faces[1].name,'Bala Ged Sanctuary');
 const repeated=await request('/api/decks/'+deck.id+'/cards','POST',{decklist:'1 Bala Ged Recovery',deduplicate:true});assert.equal(repeated.data.skipped,1);assert.equal(app.store.deck(deck.id).cards.length,1);
 const backDeck=(await request('/api/decks','POST',{name:'Back-name lookup',decklist:'1 Bala Ged Sanctuary'})).data;assert.equal((await request('/api/decks/'+backDeck.id+'/resolve','POST',{})).data.resolved,1);assert.equal(collectionCalls,1);assert.equal(namedCalls,1);
});

test('Adventure and preparation jobs retain their inset spells on one printable face',async t=>{
 const {app,request}=await setup(t);
 for(const [name,layout,spell]of [['Bonecrusher Giant','adventure','Stomp'],['Emeritus of Ideation','prepare','Ancestral Recall']]){
  const deck=(await request('/api/decks','POST',{name:layout+' fixture',decklist:'1 '+name,generate:true})).data;
  const job=await until(()=>{const j=app.store.jobs(deck.id)[0];return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(job.status,'succeeded',job.error);
  const version=app.store.versions(deck.cards[0].id)[0];assert.equal(version.summary.layout,layout);assert.equal(version.summary.spell.name,spell);assert.equal(version.faces.length,0);
  const report=JSON.parse(fs.readFileSync(version.report_path));assert.equal(report.alignment.inset_spell.side,layout==='prepare'?'right':'left');assert.equal(report.alignment.inset_spell.oracle_text,version.summary.spell.oracle_text);
  const print=await request('/api/decks/'+deck.id+'/print-preview','POST',{face_mode:'fronts'});assert.equal(print.data.count,1);
 }
});

test('prepared spell names never replace the identity or cache entry of standalone cards',async t=>{
 const preparation=JSON.parse(fs.readFileSync(path.join(process.cwd(),'data/emeritus-of-ideation.scryfall.json'))),recall={id:'standalone-recall',name:'Ancestral Recall',type_line:'Instant',mana_cost:'{U}',oracle_text:'Target player draws three cards.',layout:'normal'};
 const {app,request}=await setup(t,{metadataFetcher:async(url,options)=>new Response(JSON.stringify({data:JSON.parse(options.body).identifiers.map(i=>i.name==='Ancestral Recall'?recall:preparation)}))});
 const deck=(await request('/api/decks','POST',{name:'Prepared identity',decklist:'1 Emeritus of Ideation // Ancestral Recall'})).data;await request('/api/decks/'+deck.id+'/resolve','POST',{});
 assert.equal(app.store.get('SELECT data FROM card_cache WHERE name=?','ancestral recall'),undefined);
 const added=await request('/api/decks/'+deck.id+'/cards','POST',{decklist:'1 Ancestral Recall'});assert.equal(added.data.added,1);assert.equal(added.data.skipped,0);await request('/api/decks/'+deck.id+'/resolve','POST',{});assert.equal(app.store.deck(deck.id).cards.find(c=>c.name==='Ancestral Recall').metadata.id,'standalone-recall');
});

test('deck cancellation stops queued and running jobs only in that deck and retains finished versions',async t=>{
 const {app,request}=await setup(t);
 await request('/api/queue','POST',{paused:true});
 const first=(await request('/api/decks','POST',{name:'Cancel this deck',decklist:'1 Slow Card One\n1 Slow Card Two\n1 Sol Ring'})).data;
 const second=(await request('/api/decks','POST',{name:'Other deck',decklist:'1 Slow Card Other'})).data;
 const finishedCard=first.cards.find(c=>c.name==='Sol Ring');
 const finished=await request('/api/decks/'+first.id+'/generate','POST',{mode:'selected',card_ids:[finishedCard.id]});
 await request('/api/queue','POST',{paused:false});
 await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',finished.data.jobs[0]).status==='succeeded');
 await request('/api/queue','POST',{paused:true});
 const queued=await request('/api/decks/'+first.id+'/generate','POST',{mode:'missing'});
 const other=await request('/api/decks/'+second.id+'/generate','POST',{mode:'missing'});
 await request('/api/queue','POST',{paused:false,concurrency:1});
 await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',queued.data.jobs[0]).status==='running');
 const before=app.store.versions(finishedCard.id);assert.equal(before.length,1);
 const result=await request('/api/decks/'+first.id+'/cancel-generation','POST',{});
 assert.equal(result.status,200);assert.equal(result.data.cancelled,2);assert.equal(result.data.running,1);assert.equal(result.data.queued,1);
 for(const id of queued.data.jobs)assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',id).status,'cancelled');
 assert.notEqual(app.store.get('SELECT status FROM jobs WHERE id=?',other.data.jobs[0]).status,'cancelled');
 assert.deepEqual(app.store.versions(finishedCard.id),before);assert.ok(fs.existsSync(before[0].image_path));
 assert.equal((await request('/api/decks/'+first.id+'/cancel-generation','POST',{})).data.cancelled,0);
 assert.equal((await request('/api/decks/missing/cancel-generation','POST',{})).status,404);
});

test('blank card refinements regenerate from current deck guidelines and retain earlier artwork',async t=>{
 const {app,request}=await setup(t);
 const deck=(await request('/api/decks','POST',{name:'Optional refinement',style:'Original art direction',decklist:'1 Sol Ring',generate:true})).data;
 const card=deck.cards[0];await until(()=>app.store.versions(card.id).length===1);
 const previous=app.store.versions(card.id)[0];
 await request('/api/queue','POST',{paused:true});
 await request('/api/decks/'+deck.id,'PATCH',{style:'Updated deck guidelines: loose watercolour on textured paper.'});
 for(const body of [{},{instructions:'  \n  '}]){
  const result=await request('/api/cards/'+card.id+'/revise','POST',body);
  assert.equal(result.status,202,result.data.error);assert.equal(result.data.queued,1);
  const job=app.store.get('SELECT * FROM jobs WHERE id=?',result.data.jobs[0]),saved=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json')));
  assert.equal(saved.instructions,'');assert.equal(saved.previous_version.id,previous.id);
  assert.match(fs.readFileSync(saved.style_file,'utf8'),/Updated deck guidelines/);
  assert.match(app.queue.prompt(saved,path.join(job.directory,'request.json')),/No refinement instructions were supplied/);
  app.queue.cancel(job.id);
 }
 assert.equal(app.store.versions(card.id).length,1);assert.ok(fs.existsSync(previous.image_path));
});

test('replacing a deck list keeps artwork on remaining cards and removes unlisted entries',async t=>{
  const {app,request}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Swap',decklist:'Commander\n1 Rin and Seri, Inseparable\nDeck\n1 Sol Ring\n1 Skullclamp\n1 Arcane Signet\n8 Forest'})).data;
  const card=name=>app.store.deck(deck.id).cards.find(c=>c.name===name);
  for(const name of ['Sol Ring','Skullclamp'])app.store.addVersion(card(name).id,{image_path:'/tmp/'+name+'.png',summary:{}});
  app.store.updateCard(card('Sol Ring').id,{notes:'keep me'});
  app.store.addCard(deck.id,{name:'Cat Token',section:'tokens',token_spec:{name:'Cat Token',type_line:'Token Creature — Cat',colors:['W'],power:'1',toughness:'1',oracle_text:''}});
  const list='1 Rin and Seri, Inseparable\n1 sol ring\n1 Swords to Plowshares\n6 Forest\nSideboard\n1 Arcane Signet';
  const preview=await request(`/api/decks/${deck.id}/replace-cards`,'POST',{decklist:list});
  assert.equal(preview.status,200);
  assert.deepEqual(preview.data.removed.map(c=>[c.name,c.has_art]),[['Skullclamp',true]]);
  assert.deepEqual(preview.data.added.map(c=>c.name),['Swords to Plowshares']);
  assert.equal(preview.data.kept,4);assert.equal(preview.data.kept_art,1);assert.equal(preview.data.tokens_kept,1);
  assert.ok(card('Skullclamp'),'preview makes no changes');
  const solRing=card('Sol Ring');
  const applied=await request(`/api/decks/${deck.id}/replace-cards`,'POST',{decklist:list,apply:true});
  assert.equal(applied.status,200);
  const after=app.store.deck(deck.id).cards;
  assert.deepEqual(after.map(c=>`${c.section}:${c.quantity} ${c.name}`).sort(),['commander:1 Rin and Seri, Inseparable','main:1 Sol Ring','main:1 Swords to Plowshares','main:6 Forest','sideboard:1 Arcane Signet','tokens:1 Cat Token'].sort());
  const kept=after.find(c=>c.name==='Sol Ring');
  assert.equal(kept.id,solRing.id);assert.equal(kept.active_version_id,solRing.active_version_id);assert.equal(kept.notes,'keep me');
  // Unchecking token preservation removes tokens absent from the list; an explicit Commander section is authoritative.
  const strict=await request(`/api/decks/${deck.id}/replace-cards`,'POST',{decklist:'Commander\n1 Sol Ring\nDeck\n1 Rin and Seri, Inseparable',keep_tokens:false,apply:true});
  assert.equal(strict.status,200);
  assert.deepEqual(app.store.deck(deck.id).cards.map(c=>`${c.section}:${c.name}`).sort(),['commander:Sol Ring','main:Rin and Seri, Inseparable']);
  assert.equal(app.store.deck(deck.id).cards.find(c=>c.name==='Sol Ring').active_version_id,solRing.active_version_id);
  assert.equal((await request(`/api/decks/${deck.id}/replace-cards`,'POST',{decklist:'0 Forest'})).status,400);
  assert.match((await request(`/api/decks/${deck.id}/replace-cards`,'POST',{decklist:'1 Sol Ring\nTokens\n1 Goblin'})).data.error,/new token/);
});

test('swapping a card benches the old one with its artwork and brings sideboard cards back in',async t=>{
  const {app,request}=await setup(t);
  const deck=(await request('/api/decks','POST',{name:'Subs',decklist:'Commander\n1 Rin and Seri, Inseparable\nDeck\n2 Sol Ring\n1 Skullclamp'})).data;
  const card=(name,section)=>app.store.deck(deck.id).cards.find(c=>c.name===name&&(!section||c.section===section));
  app.store.addVersion(card('Sol Ring').id,{image_path:'/tmp/sol.png',summary:{}});
  const solRing=card('Sol Ring');
  const swapped=await request(`/api/cards/${solRing.id}/swap`,'POST',{name:'Arcane Signet'});
  assert.equal(swapped.status,200);assert.equal(swapped.data.reused,false);assert.equal(swapped.data.queued,0);
  assert.deepEqual(app.store.deck(deck.id).cards.map(c=>`${c.section}:${c.quantity} ${c.name}`).sort(),['commander:1 Rin and Seri, Inseparable','main:1 Skullclamp','main:2 Arcane Signet','sideboard:2 Sol Ring'].sort());
  assert.equal(card('Sol Ring').id,solRing.id);assert.equal(card('Sol Ring').active_version_id,solRing.active_version_id);
  // Subbing a benched card back in reuses its entry and artwork instead of creating a new one.
  const back=await request(`/api/cards/${swapped.data.id}/swap`,'POST',{name:'sol ring',generate:true});
  assert.equal(back.status,200);assert.equal(back.data.reused,true);assert.equal(back.data.id,solRing.id);assert.equal(back.data.queued,0);
  assert.equal(card('Sol Ring','main').active_version_id,solRing.active_version_id);assert.equal(card('Arcane Signet').section,'sideboard');
  // Removing instead of benching deletes the outgoing entry; same-name, token and empty swaps are refused.
  const removed=await request(`/api/cards/${card('Skullclamp').id}/swap`,'POST',{name:'Swords to Plowshares',keep_old:false});
  assert.equal(removed.status,200);assert.equal(removed.data.old.kept,false);assert.equal(card('Skullclamp'),undefined);
  assert.equal(card('Swords to Plowshares').section,'main');
  assert.match((await request(`/api/cards/${solRing.id}/swap`,'POST',{name:'SOL RING'})).data.error,/already in this slot/);
  assert.equal((await request(`/api/cards/${solRing.id}/swap`,'POST',{name:''})).status,400);
  app.store.addCard(deck.id,{name:'Cat Token',section:'tokens',token_spec:{name:'Cat Token',type_line:'Token Creature — Cat',colors:['W'],power:'1',toughness:'1',oracle_text:''}});
  assert.match((await request(`/api/cards/${card('Cat Token').id}/swap`,'POST',{name:'Goblin Token'})).data.error,/Tokens cannot be swapped/);
});

test('replacing a deck list fits art variants to the new total and refuses cards with queued jobs',async t=>{
  const {app}=await setup(t,{});
  const {spreadQuantity}=await import('../store.mjs');
  assert.deepEqual(spreadQuantity([4,3,3],12),[4,3,5]);
  assert.deepEqual(spreadQuantity([4,3,3],5),[3,1,1]);
  assert.deepEqual(spreadQuantity([4,3,3],2),[1,1,0]);
  const deck=app.store.createDeck({name:'Variants'},[{name:'Sol Ring',quantity:1,section:'main'}]);
  app.store.createVariants(deck.id,{kind:'land',name:'Forest',variants:3,total_copies:9});
  const plan=app.store.replaceCards(deck.id,[{name:'Sol Ring',quantity:1,section:'main'},{name:'Forest',quantity:4,section:'main'}]);
  assert.equal(plan.removed.length,0);
  assert.deepEqual(app.store.deck(deck.id).cards.filter(c=>c.name==='Forest').map(c=>c.quantity),[2,1,1]);
  const sol=app.store.deck(deck.id).cards.find(c=>c.name==='Sol Ring');
  app.store.run("INSERT INTO jobs(id,deck_id,card_id,type,status,version_id,directory,created_at) VALUES('j1',?,?,'generate','queued','v1','/tmp',?)",deck.id,sol.id,new Date().toISOString());
  assert.throws(()=>app.store.replaceCards(deck.id,[{name:'Forest',quantity:4,section:'main'}]),/Cancel generation for Sol Ring/);
  assert.ok(app.store.deck(deck.id).cards.find(c=>c.name==='Sol Ring'));
});

test('queue API configures Codex and Grok worker limits independently',async t=>{
 const {request}=await setup(t);let r=await request('/api/queue','POST',{provider:'grok-cli',concurrency:3});assert.equal(r.status,200);assert.deepEqual(r.data.provider_concurrency,{codex:1,'grok-cli':3});r=await request('/api/queue','POST',{provider:'codex',concurrency:2});assert.equal(r.status,200);assert.deepEqual(r.data.provider_concurrency,{codex:2,'grok-cli':3});
 const b=(await request('/api/bootstrap')).data;assert.deepEqual(b.provider_concurrency,{codex:2,'grok-cli':3});assert.equal((await request('/api/queue','POST',{provider:'other',concurrency:2})).status,400);assert.equal((await request('/api/queue','POST',{provider:'grok-cli'})).status,400);
});

test('Urabrask keeps its creature front and Saga back through trusted composition and print export',async t=>{
 const {app,request,fetchLocal,url}=await setup(t),deck=(await request('/api/decks','POST',{name:'Saga pipeline',decklist:'1 Urabrask',generate:true})).data,card=deck.cards[0];
 const version=await until(()=>{const job=app.store.jobs(deck.id)[0];if(job?.status==='failed')throw Error(job.error);return app.store.versions(card.id)[0];});
 assert.equal(version.faces.length,2);assert.equal(version.summary.faces[1].layout,'saga');assert.match(version.summary.faces[1].type_line,/Saga/);
 const back=version.faces.find(f=>f.label==='back');assert.ok(fs.existsSync(back.image_path));const report=JSON.parse(fs.readFileSync(back.image_path.replace(/\.png$/,'.report.json')));assert.deepEqual(report.alignment.saga_chapters.map(c=>c.chapter),['I','II','III']);assert.ok(report.geometry.rules_panel[3]-report.geometry.rules_panel[1]<=840);
 assert.equal((await fetchLocal(url+'/assets/'+version.id+'/back-image')).status,200);
 const printed=await request('/api/decks/'+deck.id+'/print-preview','POST',{face_mode:'backs'});assert.equal(printed.status,200);assert.equal(printed.data.count,1);assert.ok(fs.existsSync(version.image_path));
});

test('Chat HTTP endpoints persist conversations, enforce local auth and serve the complete UI',async t=>{
 const {app,request,fetchLocal,url}=await setup(t,{chatRespond:async()=>({message:'Connected through the selected provider.',calls:[]})});
 const deck=(await request('/api/decks','POST',{name:'Chat target'})).data;
 assert.equal((await request('/api/chats','POST',{provider:'other'})).status,400);
 assert.equal((await request('/api/chats','POST',{provider:'codex'},{'X-Studio-Token':'wrong'})).status,403);
 const created=await request('/api/chats','POST',{provider:'grok-cli',deck_id:deck.id,allow_write:false});assert.equal(created.status,201);assert.equal(created.data.allow_write,0);
 const sent=await request('/api/chats/'+created.data.id+'/messages','POST',{message:'Hello'});assert.equal(sent.status,202);
 await until(()=>!app.chat.active.has(created.data.id));const detail=await request('/api/chats/'+created.data.id);assert.equal(detail.data.messages.at(-1).content,'Connected through the selected provider.');assert.equal(detail.data.provider,'grok-cli');
 assert.equal((await request('/api/chats')).data.length,1);assert.equal((await request('/api/chats/'+created.data.id+'/messages','POST',{message:' '})).status,400);
 for(const asset of ['/chat.js','/chat.css']){const response=await fetchLocal(url+asset);assert.equal(response.status,200);assert.ok((await response.text()).length>100);}
 assert.equal((await request('/api/chats/'+created.data.id+'/cancel','POST',{})).status,200);
});

test('regeneration history defaults on; scratch jobs exclude old inputs, use current style and retain the choice on retry',async t=>{
 const {app,request,dir}=await setup(t,{imageProviderStatus:()=>[{id:'grok-cli',available:true}]});app.queue.setPaused(true);
 const deck=(await request('/api/decks','POST',{name:'History control',style:'Old realistic style',decklist:'1 Sol Ring'})).data,card=deck.cards[0];
 app.store.addVersion(card.id,{id:'historical-card',summary:{name:'Sol Ring',display_name:'Old illustration title'},image_path:path.join(dir,'old-image.png'),manifest_path:path.join(dir,'old-manifest.json'),style_text:'Old realistic style'});
 await request('/api/decks/'+deck.id+'/guidelines','PATCH',{mode:'custom',custom_prompt:'NEW stylized ink-and-gouache direction.'});
 const refFile=path.join(dir,'character.png');fs.writeFileSync(refFile,'reference bytes');app.store.run('INSERT INTO art_references(id,owner_type,owner_id,name,mime,width,height,bytes,sha256,original_path,image_path,thumb_path,features,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)','character-ref','deck',deck.id,'Character only','image/png',1,1,15,'hash',refFile,refFile,refFile,'["characters"]',new Date().toISOString());app.store.run('UPDATE art_references SET art_set_id=? WHERE id=?',deck.active_art_set_id,'character-ref');
 const read=jid=>JSON.parse(fs.readFileSync(path.join(app.store.get('SELECT directory FROM jobs WHERE id=?',jid).directory,'request.json')));
 const normal=await request('/api/cards/'+card.id+'/revise','POST',{});assert.equal(normal.status,202);assert.equal(read(normal.data.jobs[0]).include_history,true);assert.equal(read(normal.data.jobs[0]).previous_version.id,'historical-card');app.queue.cancel(normal.data.jobs[0]);
 assert.equal((await request('/api/cards/'+card.id+'/revise','POST',{include_history:'false'})).status,400);
 for(const provider of ['codex','grok-cli']){
  app.store.updateDeck(deck.id,{image_provider:provider});const scratch=await request('/api/cards/'+card.id+'/revise','POST',{instructions:'A new art style.',include_history:false});assert.equal(scratch.status,202);const frozen=read(scratch.data.jobs[0]);assert.equal(frozen.include_history,false);assert.equal(frozen.previous_version,null);assert.equal(frozen.card.scene_plan,null);assert.equal(frozen.image_generation.provider,provider);assert.equal(fs.readFileSync(frozen.style_file,'utf8'),'NEW stylized ink-and-gouache direction.');assert.deepEqual(frozen.style_context.reference_images[0].features,['characters']);
  const prompt=app.queue.prompt(frozen,'request.json');assert.match(prompt,/START FROM SCRATCH/);assert.match(prompt,/Do not preserve the old composition/);assert.doesNotMatch(prompt,/For revisions, inspect and optionally edit the previous RAW ART/);assert.doesNotMatch(prompt,/Existing project artwork and the previous version can be read as references/);
  app.queue.cancel(scratch.data.jobs[0]);const retry=app.queue.retry(scratch.data.jobs[0])[0];assert.equal(read(retry).include_history,false);assert.equal(read(retry).previous_version,null);app.queue.cancel(retry);
 }
 assert.equal(app.store.versions(card.id).length,1);assert.equal(app.store.deck(deck.id).cards[0].active_version_id,'historical-card');assert.throws(()=>app.queue.enqueue(deck.id,{mode:'selected',card_ids:[card.id],type:'compose',include_history:false}),/require the existing artwork/);
 app.store.updateDeck(deck.id,{image_provider:'codex'});const fresh=(await request('/api/cards/'+card.id+'/revise','POST',{include_history:false})).data.jobs[0];app.queue.setPaused(false);
 const completed=await until(()=>{const j=app.store.get('SELECT * FROM jobs WHERE id=?',fresh);return ['succeeded','failed'].includes(j.status)&&j;});assert.equal(completed.status,'succeeded',completed.error);assert.equal(app.store.versions(card.id).length,2);assert.ok(app.store.versions(card.id).some(v=>v.id==='historical-card'));
});

test('every card-generation HTTP entry point freezes history, reference and isolation choices',async t=>{
 const {app,request}=await setup(t);app.queue.setPaused(true);const flags={include_history:false,use_reference_images:false,isolate_generation:true};
 const created=await request('/api/decks','POST',{name:'Generation options',decklist:'1 Sol Ring',generate:true,...flags});assert.equal(created.status,201);const deck=created.data;
 const saved=jid=>JSON.parse(fs.readFileSync(path.join(app.store.get('SELECT directory FROM jobs WHERE id=?',jid).directory,'request.json')));const check=r=>{for(const [key,value]of Object.entries(flags))assert.equal(r[key],value,key);};
 const first=app.store.jobs(deck.id)[0];check(saved(first.id));app.queue.cancel(first.id);
 const all=await request('/api/decks/'+deck.id+'/generate','POST',{mode:'all',...flags});check(saved(all.data.jobs[0]));app.queue.cancel(all.data.jobs[0]);
 const revision=await request('/api/cards/'+deck.cards[0].id+'/revise','POST',flags);check(saved(revision.data.jobs[0]));app.queue.cancel(revision.data.jobs[0]);
 const options=await request('/api/jobs/'+revision.data.jobs[0]);assert.deepEqual(options.data.generation_options,flags);
 const retry=await request('/api/jobs/'+revision.data.jobs[0]+'/retry','POST',{include_history:true,use_reference_images:true,isolate_generation:false});const retried=saved(retry.data.jobs[0]);assert.equal(retried.include_history,true);assert.equal(retried.use_reference_images,true);assert.equal(retried.isolate_generation,false);app.queue.cancel(retry.data.jobs[0]);
 const variants=await request('/api/decks/'+deck.id+'/variants','POST',{kind:'land',name:'Forest',variants:2,total_copies:2,generate:true,...flags});assert.equal(variants.status,201);assert.equal(variants.data.queued,2);for(const job of app.store.jobs(deck.id).filter(j=>j.status==='queued'))check(saved(job.id));
});


test('official printing HTTP picker, rollback, generation exclusions, cross-deck isolation and duplex export',async t=>{
  const printingId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',oracle='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const {execFileSync}=await import('node:child_process');
  const bytes=execFileSync('python3',['-c',"from PIL import Image; import io,sys; b=io.BytesIO(); Image.new('RGBA',(745,1040),(20,50,30,255)).save(b,format='PNG'); sys.stdout.buffer.write(b.getvalue())"]);
  const printing={id:printingId,oracle_id:oracle,name:'Test Front // Test Back',layout:'transform',set:'qa',set_name:'Official QA',collector_number:'1',card_faces:[{name:'Test Front',image_uris:{normal:'https://cards.scryfall.io/normal/front.jpg',png:'https://cards.scryfall.io/png/front.png'}},{name:'Test Back',image_uris:{normal:'https://cards.scryfall.io/normal/back.jpg',png:'https://cards.scryfall.io/png/back.png'}}]};
  const officialFetcher=async url=>url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):new Response(JSON.stringify({data:[printing],total_cards:1,has_more:false}),{headers:{'Content-Type':'application/json'}});
  const {app,request,fetchLocal,url,dir}=await setup(t,{officialFetcher});app.queue.setPaused(true);
  const deck=(await request('/api/decks','POST',{name:'Official QA',decklist:'1 Test Front // Test Back'})).data,card=deck.cards[0];app.store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify({oracle_id:oracle}),card.id);
  const old=app.store.addVersion(card.id,{image_path:path.join(dir,'old.png'),summary:{name:card.name}});fs.writeFileSync(path.join(dir,'old.png'),bytes);
  const list=await request(`/api/cards/${card.id}/official-printings`);assert.equal(list.status,200);assert.equal(list.data.cards[0].faces.length,2);
  const selected=await request(`/api/cards/${card.id}/official-printing`,'POST',{printing_id:printingId});assert.equal(selected.status,201,JSON.stringify(selected.data));assert.equal(selected.data.faces[0].dpi,300);
  await request(`/api/decks/${deck.id}`,'PATCH',{border_settings:{style:'modern',width_mm:2.2}});
  await request(`/api/cards/${card.id}`,'PATCH',{border_settings:{style:'white',width_mm:2}});
  for(const face of ['image','back-image']){
    const image=await fetchLocal(url+`/assets/${selected.data.version_id}/${face}`);
    assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes,'official pixels bypass deck and card borders');
  }
  assert.equal((await request(`/api/cards/${card.id}`)).data.art_mode,'official');assert.equal((await request(`/api/decks/${deck.id}/generate`,'POST',{mode:'all'})).data.queued,0);assert.equal((await request(`/api/decks/${deck.id}/reframe`,'POST',{})).data.queued,0);
  assert.equal((await fetchLocal(url+`/official-printing-images/${printingId}/0/png`)).status,200);assert.equal((await fetchLocal(url+`/assets/${selected.data.version_id}/back-image`)).status,200);
  const boot=(await request('/api/bootstrap')).data;const pdf=await fetchLocal(url+`/api/decks/${deck.id}/print.pdf`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:JSON.stringify({face_mode:'duplex',quality:'compact'})});assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
  const zip=await fetchLocal(url+`/api/decks/${deck.id}/export.zip`);assert.equal(zip.status,200);assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0,2).toString(),'PK');
  const other=(await request('/api/decks','POST',{name:'Independent',decklist:'1 Test Front // Test Back'})).data;assert.equal(other.cards[0].active_version_id,null);assert.ok(!(await request(`/api/cards/${other.cards[0].id}/artwork-sources`)).data.some(v=>v.id===selected.data.version_id));
  await request(`/api/cards/${card.id}/use-custom-art`,'POST',{});assert.equal(app.store.deck(deck.id).cards[0].active_version_id,old);
  await request(`/api/versions/${selected.data.version_id}/activate`,'POST',{});assert.equal(app.store.deck(deck.id).cards[0].art_mode,'official');assert.equal(app.store.versions(card.id).length,2);
  assert.equal((await request(`/api/cards/${card.id}/official-printing`,'POST',{printing_id:'bad'})).status,400);
});


test('decklist exact printings download in the background, persist distinct editions, de-duplicate and retry failures',async t=>{
 const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',O='cccccccc-cccc-cccc-cccc-cccccccccccc';
 const {execFileSync}=await import('node:child_process');const png=execFileSync('python3',['-c',"from PIL import Image; import io,sys; b=io.BytesIO(); Image.new('RGB',(745,1040)).save(b,format='PNG'); sys.stdout.buffer.write(b.getvalue())"]);
 let fail=false,returnedSet='test';const officialFetcher=async url=>{if(url.includes('scryfall.io'))return new Response(png,{headers:{'Content-Type':'image/png'}});if(fail)throw Error('offline');const num=url.endsWith('/2')?'2':'1';return new Response(JSON.stringify({id:num==='2'?B:A,oracle_id:O,name:'Sol Ring',set:returnedSet,set_name:'Test printings',collector_number:num,lang:'en',image_uris:{png:'https://cards.scryfall.io/'+num+'.png'}}),{headers:{'Content-Type':'application/json'}});};
 const {app,request,fetchLocal,url}=await setup(t,{officialFetcher});app.queue.setPaused(true);
 const deck=(await request('/api/decks','POST',{name:'Mixed import',decklist:'2 x Sol Ring TEST 1\n1 Sol Ring (TEST) 2\n1 Forest',generate:true})).data;assert.equal(deck.cards.length,3);assert.equal(deck.queued,1,'only the plain Forest is queued for AI');const official=deck.cards.filter(c=>c.art_mode==='official');assert.equal(official.length,2);assert.equal(official[0].active_version_id,null,'request returns without waiting for scan downloads');
 await until(()=>app.store.deck(deck.id).cards.filter(c=>c.art_mode==='official').every(c=>c.active_version_id));assert.equal(app.store.versions(official[0].id).length,1);assert.equal(app.store.jobs(deck.id)[0].card_name,'Forest');
 const repeated=await request(`/api/decks/${deck.id}/cards`,'POST',{decklist:'1 Sol Ring (TEST) 1\n1 Sol Ring TEST 2',deduplicate:true});assert.equal(repeated.data.skipped,2);assert.equal(app.store.deck(deck.id).cards[0].quantity,2);assert.equal(app.store.versions(official[0].id).length,1);
 const text=await(await fetchLocal(url+`/api/decks/${deck.id}/decklist.txt`)).text();assert.match(text,/2 Sol Ring \(TEST\) 1/);assert.match(text,/1 Sol Ring \(TEST\) 2/);
 const plain=await request(`/api/decks/${deck.id}/cards`,'POST',{decklist:'1 Sol Ring',deduplicate:true});assert.equal(plain.data.skipped,1,'a name-only repeat preserves existing artwork');assert.equal(app.store.deck(deck.id).cards.length,3);
 fail=true;const failed=(await request('/api/decks','POST',{name:'Offline import',decklist:'1 Sol Ring NEW 1'})).data;await until(()=>app.store.deck(failed.id).cards[0].printing_error);assert.equal(app.store.deck(failed.id).cards[0].art_mode,'official');assert.equal(app.store.jobs(failed.id).length,0);assert.equal(app.store.versions(failed.cards[0].id).length,0);
 fail=false;const retry=await request(`/api/cards/${failed.cards[0].id}/retry-official-import`,'POST',{});assert.equal(retry.status,200);await until(()=>app.store.deck(failed.id).cards[0].printing_error);assert.match(app.store.deck(failed.id).cards[0].printing_error,/different set/,'mismatched editions never silently fall back');returnedSet='new';await request(`/api/cards/${failed.cards[0].id}/retry-official-import`,'POST',{});await until(()=>app.store.deck(failed.id).cards[0].active_version_id);assert.equal(app.store.deck(failed.id).cards[0].printing_error,'');
});

test('deck art-set HTTP workflow keeps each guide, generation history and export independent',async t=>{
 const {app,request,dir,fetchLocal,url}=await setup(t),deck=(await request('/api/decks','POST',{name:'Art-set roundtrip',style:'Original exact style.',decklist:'1 Sol Ring'})).data,card=deck.cards[0],original=deck.active_art_set_id;
 assert.equal(deck.art_sets.length,1);const firstJob=(await request(`/api/decks/${deck.id}/generate`,'POST',{mode:'all'})).data.jobs[0];await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',firstJob).status==='succeeded');const first=app.store.deck(deck.id).cards[0].active_version_id;
 const fresh=(await request(`/api/decks/${deck.id}/art-sets`,'POST',{name:'Ink edition',mode:'fresh',guidelines:'fresh',style:'Ink-only exact style.'})).data;assert.ok(fresh.id);assert.equal((await request(`/api/cards/${card.id}`)).data.versions.length,0);assert.equal((await request(`/api/decks/${deck.id}/guidelines`)).data.custom_prompt,'Ink-only exact style.');
 const secondJob=(await request(`/api/decks/${deck.id}/generate`,'POST',{mode:'all',include_history:true,use_reference_images:false,isolate_generation:false})).data.jobs[0];await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',secondJob).status==='succeeded');const second=app.store.deck(deck.id).cards[0].active_version_id;assert.notEqual(first,second);const job=app.store.get('SELECT * FROM jobs WHERE id=?',secondJob),saved=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json')));assert.equal(saved.previous_version,null);assert.equal(saved.art_set_id,fresh.id);assert.equal(fs.readFileSync(saved.style_file,'utf8'),'Ink-only exact style.');
 await request(`/api/decks/${deck.id}/art-sets/${original}/activate`,'POST',{});assert.equal((await request(`/api/cards/${card.id}`)).data.active_version_id,first);assert.equal((await request(`/api/cards/${card.id}`)).data.versions.length,1);assert.equal((await request(`/api/decks/${deck.id}/guidelines`)).data.custom_prompt,'Original exact style.');
 assert.equal((await request(`/api/versions/${second}/activate`,'POST',{})).status,400);assert.equal((await request(`/api/decks/${deck.id}/guidelines`,'PATCH',{art_set_id:fresh.id,custom_prompt:'Wrong set'})).status,400);
 const pdf=await fetchLocal(url+`/api/decks/${deck.id}/print.pdf`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':(await request('/api/bootstrap')).data.token},body:JSON.stringify({quality:'compact'})});assert.equal(pdf.status,200);const exports=fs.readdirSync(path.join(dir,'exports')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,'exports',n))));assert.equal(exports.at(-1).entries[0].original_image_path,app.store.get('SELECT image_path FROM versions WHERE id=?',first).image_path);
 const copy=(await request(`/api/decks/${deck.id}/art-sets`,'POST',{name:'Copy of original',mode:'copy',guidelines:'copy'})).data;assert.equal((await request(`/api/cards/${card.id}`)).data.active_version_id,first);await request(`/api/decks/${deck.id}/guidelines`,'PATCH',{custom_prompt:'Copied edition edited independently'});await request(`/api/decks/${deck.id}/art-sets/${copy.id}`,'PATCH',{name:'Renamed copy'});assert.equal((await request(`/api/decks/${deck.id}/art-sets`)).data.sets.find(s=>s.id===copy.id).name,'Renamed copy');
 app.queue.setPaused(true);const queued=(await request(`/api/decks/${deck.id}/generate`,'POST',{mode:'all'})).data.jobs[0];assert.equal((await request(`/api/decks/${deck.id}/art-sets/${fresh.id}/activate`,'POST',{})).status,400);await request(`/api/jobs/${queued}/cancel`,'POST',{});await request(`/api/decks/${deck.id}/art-sets/${original}/activate`,'POST',{});assert.equal((await request(`/api/decks/${deck.id}/guidelines`)).data.custom_prompt,'Original exact style.');
});

test('Populate MTG art HTTP action fills only blank cards in the selected set and retains both faces',async t=>{
 const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',O='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';const {execFileSync}=await import('node:child_process');const bytes=execFileSync('python3',['-c',"from PIL import Image;import io,sys;b=io.BytesIO();Image.new('RGB',(745,1040)).save(b,format='PNG');sys.stdout.buffer.write(b.getvalue())"]);
 const printing={id:A,oracle_id:O,name:'Test Front // Test Back',set:'test',set_name:'Test',collector_number:'1',layout:'transform',card_faces:[{name:'Test Front',image_uris:{png:'https://cards.scryfall.io/front.png'}},{name:'Test Back',image_uris:{png:'https://cards.scryfall.io/back.png'}}]};
 const officialFetcher=async url=>url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):new Response(JSON.stringify(url.includes('/search?')?{data:[printing],total_cards:1,has_more:false}:printing),{headers:{'Content-Type':'application/json'}});
 const {app,request,dir}=await setup(t,{officialFetcher}),deck=(await request('/api/decks','POST',{name:'Populate official',decklist:'1 Test Front // Test Back\n1 Forest'})).data;app.queue.setPaused(true);const original=deck.active_art_set_id,card=deck.cards[0],forest=deck.cards[1];app.store.addVersion(forest.id,{image_path:path.join(dir,'existing.png'),summary:{name:'Forest'}});app.store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify({name:printing.name,oracle_id:O}),card.id);
 const queued=await request(`/api/decks/${deck.id}/populate-mtg-art`,'POST',{art_set_id:original});assert.equal(queued.status,202);assert.equal(queued.data.queued,1);assert.equal((await request(`/api/decks/${deck.id}/populate-mtg-art`,'POST',{})).data.queued,0);await until(()=>app.store.deck(deck.id).cards[0].active_version_id);assert.equal(app.store.versions(card.id)[0].faces.length,2);assert.equal(app.store.versions(forest.id).length,1);assert.equal(app.store.jobs(deck.id).length,0);
 const alternate=(await request(`/api/decks/${deck.id}/art-sets`,'POST',{name:'Fresh',mode:'fresh'})).data;assert.equal((await request(`/api/cards/${card.id}`)).data.active_version_id,null);assert.equal((await request(`/api/decks/${deck.id}/populate-mtg-art`,'POST',{art_set_id:original})).status,400);assert.equal(app.store.deck(deck.id).active_art_set_id,alternate.id);
});

test('single-card and multi-card PDFs pin versions, respect page ranges, ignore unrelated blanks and preserve inventory',async t=>{
 const {app,request,fetchLocal,url,dir}=await setup(t),deck=(await request('/api/decks','POST',{name:'Print selection',decklist:'8 Sol Ring\nSideboard\n2 Forest\nDeck\n1 Missing card'})).data,a=deck.cards.find(c=>c.name==='Sol Ring'),b=deck.cards.find(c=>c.name==='Forest');
 const {execFileSync}=await import('node:child_process');for(const [name,color]of [['old','red'],['new','blue'],['back','green'],['forest','yellow']])execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(745,1040),sys.argv[2]).save(sys.argv[1])',path.join(dir,name+'.png'),color]);
 const old=app.store.addVersion(a.id,{image_path:path.join(dir,'old.png'),summary:{name:a.name},faces:[{label:'back',image_path:path.join(dir,'back.png')}]}),current=app.store.addVersion(a.id,{image_path:path.join(dir,'new.png'),summary:{name:a.name}});app.store.addVersion(b.id,{image_path:path.join(dir,'forest.png'),summary:{name:b.name}});
 const scope={card_ids:[a.id],version_id:old,copies:1,art_set_id:deck.active_art_set_id,quality:'compact'};let preview=await request(`/api/decks/${deck.id}/print-preview`,'POST',scope);assert.equal(preview.status,200);assert.equal(preview.data.count,1);assert.deepEqual(preview.data.missing,[]);
 const boot=(await request('/api/bootstrap')).data;async function pdf(settings){const r=await fetchLocal(url+`/api/decks/${deck.id}/print.pdf`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:JSON.stringify(settings)});const bytes=Buffer.from(await r.arrayBuffer());assert.equal(r.status,200,bytes.toString());return bytes.toString('latin1');}
 const first=await pdf(scope);assert.equal((first.match(/\/Type\s*\/Page\b/g)||[]).length,1);let saved=fs.readdirSync(path.join(dir,'exports')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,'exports',n))));assert.equal(saved.at(-1).entries[0].original_image_path,path.join(dir,'old.png'));assert.equal(app.store.get('SELECT quantity,active_version_id FROM cards WHERE id=?',a.id).quantity,8);assert.equal(app.store.get('SELECT active_version_id FROM cards WHERE id=?',a.id).active_version_id,current);
 preview=await request(`/api/decks/${deck.id}/print-preview`,'POST',{card_ids:[a.id,b.id],include_sideboard:false});assert.equal(preview.data.count,10);const pageTwo=await pdf({card_ids:[a.id,b.id],page_range:'2',quality:'compact'});assert.equal((pageTwo.match(/\/Type\s*\/Page\b/g)||[]).length,1);
 const backs=await pdf({...scope,copies:10,face_mode:'duplex',page_range:'2,4'});assert.equal((backs.match(/\/Type\s*\/Page\b/g)||[]).length,2);const calibration=await pdf({...scope,calibration:true,page_range:'2'});assert.equal((calibration.match(/\/Type\s*\/Page\b/g)||[]).length,1);assert.doesNotMatch(calibration,/\/Subtype\s*\/Image\b/);
 assert.equal((await request(`/api/decks/${deck.id}/print-preview`,'POST',{card_ids:[]})).status,400);assert.equal((await request(`/api/decks/${deck.id}/print-preview`,'POST',{...scope,page_range:'3'})).status,400);const foreign=(await request('/api/decks','POST',{name:'Other',decklist:'1 Sol Ring'})).data;assert.equal((await request(`/api/decks/${deck.id}/print-preview`,'POST',{card_ids:[foreign.cards[0].id]})).status,400);
});

test('outer borders apply consistently to assets, PDFs and ZIPs while preserving source versions and per-set settings',async t=>{
 const {app,request,fetchLocal,url,dir}=await setup(t),deck=(await request('/api/decks','POST',{name:'Border finish',decklist:'1 Sol Ring'})).data,card=deck.cards[0],source=path.join(dir,'border-source.png');const {execFileSync}=await import('node:child_process');execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(745,1040),"orange").save(sys.argv[1])',source]);const version=app.store.addVersion(card.id,{image_path:source,summary:{name:card.name}}),original=fs.readFileSync(source),before=(await request('/api/bootstrap')).data.border_revision;
 const first=await fetchLocal(url+`/assets/${version}/image`);assert.equal(first.status,200);assert.notDeepEqual(Buffer.from(await first.arrayBuffer()),original);assert.deepEqual(fs.readFileSync(source),original);
 await request(`/api/decks/${deck.id}`,'PATCH',{border_settings:{style:'modern',width_mm:1.2}});assert.ok((await request('/api/bootstrap')).data.border_revision>before);await request(`/api/cards/${card.id}`,'PATCH',{border_settings:{style:'none',width_mm:0}});assert.deepEqual(Buffer.from(await(await fetchLocal(url+`/assets/${version}/image`)).arrayBuffer()),original);
 await request(`/api/cards/${card.id}`,'PATCH',{border_settings:{}});const boot=(await request('/api/bootstrap')).data;const pdf=await fetchLocal(url+`/api/decks/${deck.id}/print.pdf`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:JSON.stringify({quality:'compact'})});assert.equal(pdf.status,200);const saved=fs.readdirSync(path.join(dir,'exports')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,'exports',n))));assert.equal(saved.at(-1).entries[0].original_image_path,source);assert.match(saved.at(-1).entries[0].image_path,/border-cache/);assert.equal(saved.at(-1).entries[0].border_settings.style,'modern');
 const zip=await fetchLocal(url+`/api/decks/${deck.id}/export.zip`);assert.equal(zip.status,200);assert.equal(app.store.versions(card.id).length,1);assert.equal((await request(`/api/cards/${card.id}`,'PATCH',{border_settings:{style:'black',width_mm:99}})).status,400);
 const other=(await request(`/api/decks/${deck.id}/art-sets`,'POST',{name:'White',mode:'copy'})).data;await request(`/api/decks/${deck.id}`,'PATCH',{border_settings:{style:'white',width_mm:2}});await request(`/api/decks/${deck.id}/art-sets/${deck.active_art_set_id}/activate`,'POST',{});assert.equal(JSON.parse(app.store.deck(deck.id).border_settings).style,'modern');assert.notEqual(other.id,deck.active_art_set_id);
});

test('global print studio searches arbitrary official printings and prints mixed cross-deck artwork without altering decks',async t=>{
 const P='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';const {execFileSync}=await import('node:child_process');
 const bytes=execFileSync('python3',['-c',"from PIL import Image;import io,sys;b=io.BytesIO();Image.new('RGB',(744,1040),'orange').save(b,format='PNG');sys.stdout.buffer.write(b.getvalue())"]);
 const printing={id:P,name:'Random Real Card',set:'test',set_name:'Any printing',collector_number:'7',border_color:'borderless',image_uris:{normal:'https://cards.scryfall.io/normal/test.jpg',png:'https://cards.scryfall.io/png/test.png'}};
 const calls=[];const officialFetcher=async url=>{calls.push(url);return url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):new Response(JSON.stringify({data:[printing],has_more:false,total_cards:1}),{headers:{'Content-Type':'application/json'}});};
 const {app,request,fetchLocal,url,dir}=await setup(t,{officialFetcher});app.queue.setPaused(true);
 const decks=[];for(const name of ['One','Two']){const d=(await request('/api/decks','POST',{name,decklist:'1 Sol Ring'})).data;const source=path.join(dir,name+'.png');fs.writeFileSync(source,bytes);const version=app.store.addVersion(d.cards[0].id,{image_path:source,summary:{name:'Sol Ring',display_name:name}});decks.push({deck:d,version});}
 assert.equal((await request('/api/print-library')).data.cards.length,2);
 const search=await request('/api/print-official?query='+encodeURIComponent('!"Random Real Card"'));assert.equal(search.status,200);assert.equal(search.data.cards[0].id,P);assert.ok(calls.some(url=>new URL(url).searchParams.get('q')==='!"Random Real Card"'));
 const result=await request('/api/print-tray','POST',{items:[...decks.map(({deck,version})=>({version_id:version,art_set_id:deck.active_art_set_id,quantity:2})),{printing_id:P,quantity:1}]});assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.count,5);
 const scan=result.data.items.find(i=>i.printing_id);assert.deepEqual(Buffer.from(await(await fetchLocal(url+scan.preview)).arrayBuffer()),bytes);
 const settings={quality:'compact',face_mode:'fronts',items:result.data.items.map(i=>({id:i.id,quantity:i.quantity}))};
 const preview=await request('/api/print/preview','POST',settings);assert.equal(preview.status,200);assert.equal(preview.data.count,5);assert.equal(preview.data.card_width,63.5);assert.equal(preview.data.card_height,88.9);
 const boot=(await request('/api/bootstrap')).data;const pdf=await fetchLocal(url+'/api/print/pdf',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:JSON.stringify(settings)});assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
 const manifest=fs.readdirSync(path.join(dir,'exports')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'exports',f)))).find(m=>m.deck_name==='Print tray');assert.equal(manifest.entries.length,3);assert.equal(manifest.entries.find(e=>e.printing_id===P).border_settings.style,'none');
 for(const {deck,version} of decks){assert.equal(app.store.deck(deck.id).cards[0].active_version_id,version);assert.equal(app.store.versions(deck.cards[0].id).length,1);}
 assert.equal((await request('/api/print-tray/'+scan.id,'PATCH',{quantity:4})).data.count,8);assert.equal((await request('/api/print-tray/'+scan.id,'DELETE')).data.count,4);
 assert.equal((await fetchLocal(url+'/print-studio.js')).status,200);
 await request('/api/print-tray','DELETE');assert.equal((await request('/api/print/preview','POST',settings)).status,400);
});

test('quality endpoints report actual pixels, accept native export and import full-resolution images',async t=>{
 const {app,request,fetchLocal,url,dir}=await setup(t);const {execFileSync}=await import('node:child_process');const bytes=execFileSync('python3',['-c','from PIL import Image;import io,sys;b=io.BytesIO();Image.new("RGB",(3000,4200),"orange").save(b,format="PNG");sys.stdout.buffer.write(b.getvalue())']);const d=(await request('/api/decks','POST',{name:'Quality reports',decklist:'1 Sol Ring'})).data,source=path.join(dir,'hires.png');fs.writeFileSync(source,bytes);const version=app.store.addVersion(d.cards[0].id,{image_path:source,summary:{name:'Sol Ring'}});
 const report=await request(`/api/versions/${version}/quality`);assert.equal(report.status,200);assert.deepEqual([report.data.faces[0].width,report.data.faces[0].height],[3000,4200]);assert.equal(report.data.faces[0].effective_ppi,1200);
 const imported=await request('/api/print-imports','POST',{name:'High-resolution import',front:'data:image/png;base64,'+bytes.toString('base64'),bleed_mm:0});assert.equal(imported.status,201,JSON.stringify(imported.data));assert.equal((await fetchLocal(url+`/print-import-assets/${imported.data.id}/front`)).status,200);
 const tray=await request('/api/print-tray','POST',{items:[{import_id:imported.data.id}]});assert.equal(tray.status,201);const preview=await request('/api/print/preview','POST',{quality:'full'});assert.equal(preview.data.quality,'full');assert.equal((await request('/api/print/preview','POST',{quality:'1200'})).status,200);assert.equal((await request('/api/print/preview','POST',{quality:'unknown'})).status,400);assert.equal((await request('/api/quality-refresh')).status,200);
 const boot=(await request('/api/bootstrap')).data,pdf=await fetchLocal(url+'/api/print/pdf',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:JSON.stringify({quality:'full'})});assert.equal(pdf.status,200);
 const pdfFile=fs.readdirSync(path.join(dir,'exports')).find(f=>f.endsWith('.pdf'));const data=fs.readFileSync(path.join(dir,'exports',pdfFile)).toString('latin1');assert.match(data,/\/Width 3000/);assert.match(data,/\/Height 4200/,'native image is not reduced to 600 PPI');
});

test('frame task queue includes active and completed revisions, progress and validation failures',async t=>{
 const {app,request,dir}=await setup(t),set='frame-queue-test',version='frame-task-test',directory=path.join(dir,'frame-task');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'validation.log'),'Layout validation details\nValueError: rejected geometry\n');
 app.store.run('INSERT INTO frame_sets(id,name,brief,created_at) VALUES(?,?,?,?)',set,'Queue frame','Frame queue fixture',new Date().toISOString());app.store.run('INSERT INTO frame_versions(id,set_id,status,directory,progress,created_at) VALUES(?,?,?,?,?,?)',version,set,'running',directory,'Rendering colour matrix',new Date().toISOString());
 const running=await request('/api/frame-jobs');assert.equal(running.status,200);assert.equal(running.data.find(j=>j.id===version).status,'running');assert.equal(running.data.find(j=>j.id===version).frame_name,'Queue frame');assert.ok(!running.data.some(j=>j.id==='included-v1'));
 app.store.run("UPDATE frame_versions SET status='failed',error='Bad geometry' WHERE id=?",version);const failure=await request('/api/frame-jobs/'+version);assert.equal(failure.data.error,'Bad geometry');assert.match(failure.data.log,/rejected geometry/);
 app.store.run("UPDATE frame_versions SET status='ready',error=NULL,progress='All required templates passed' WHERE id=?",version);assert.equal((await request('/api/frame-jobs')).data.find(j=>j.id===version).status,'ready');assert.equal((await request('/api/frame-jobs/missing')).status,400);assert.equal((await request('/api/bootstrap')).data.frame_queue,true);
});

test('frame inspiration API lists inactive artwork sets without switching decks',async t=>{
 const {app,request}=await setup(t);const deck=app.store.createDeck({name:'Frame inspiration',style:'Blue glass'});
 const second=app.store.artSets.create(deck.id,{name:'Silver',mode:'fresh'});
 const result=await request('/api/frame-deck-sources');assert.equal(result.status,200);
 const source=result.data.find(d=>d.id===deck.id);assert.equal(source.art_sets.length,2);assert.equal(source.art_sets.find(a=>a.active).id,second.id);
 assert.equal(app.store.deck(deck.id).active_art_set_id,second.id);
});

test('separate-page print ZIPs preserve resolution, page ranges, duplex order and calibration for decks and trays',async t=>{
 const {app,request,fetchLocal,url,dir}=await setup(t);
 const deck=(await request('/api/decks','POST',{name:'Split sheets',decklist:'10 Sol Ring'})).data,card=deck.cards[0];
 const {execFileSync}=await import('node:child_process');
 const front=path.join(dir,'split-front.png'),back=path.join(dir,'split-back.png');
 execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(745,1040),"red").save(sys.argv[1]);Image.new("RGB",(745,1040),"blue").save(sys.argv[2])',front,back]);
 const version=app.store.addVersion(card.id,{image_path:front,summary:{name:card.name},faces:[{label:'back',image_path:back}]});
 const token=(await request('/api/bootstrap')).data.token;
 async function archive(route,settings){
  const response=await fetchLocal(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify({quality:'600',packaging:'per_page',...settings})});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');assert.match(response.headers.get('content-disposition'),/-print-pages\.zip/);
  const filename=path.join(dir,'inspect.zip');fs.writeFileSync(filename,Buffer.from(await response.arrayBuffer()));
  return JSON.parse(execFileSync('python3',['-c',`import zipfile,re,json,sys
with zipfile.ZipFile(sys.argv[1]) as archive:
 result=[]
 for name in archive.namelist():
  data=archive.read(name)
  assert data.startswith(b'%PDF')
  result.append(dict(name=name,pages=len(re.findall(rb'/Type\\s*/Page\\b',data)),images=len(re.findall(rb'/Subtype\\s*/Image\\b',data)),widths=[int(x) for x in re.findall(rb'/Width\\s+(\\d+)',data)],heights=[int(x) for x in re.findall(rb'/Height\\s+(\\d+)',data)],media=[float(x) for x in re.search(rb'/MediaBox\\s*\\[([^]]+)\\]',data)[1].split()]))
 print(json.dumps(result))`,filename],{encoding:'utf8'}));
 }
 const route=`/api/decks/${deck.id}/print.pdf`;
 const all=await archive(route,{face_mode:'duplex',calibration:true});
 assert.deepEqual(all.map(p=>p.name),['page-001-front.pdf','page-002-back.pdf','page-003-front.pdf','page-004-back.pdf','page-005-calibration.pdf']);
 for(const page of all){assert.equal(page.pages,1);assert.ok(Math.abs(page.media[2]-210/25.4*72)<.001);assert.ok(Math.abs(page.media[3]-297/25.4*72)<.001);}
 for(const page of all.slice(0,4)){assert.equal(page.images,1);assert.deepEqual(page.widths,[1500]);assert.deepEqual(page.heights,[2100]);}
 assert.equal(all[4].images,0);
 const selected=await archive(route,{face_mode:'duplex',calibration:true,page_range:'2,3,5'});
 assert.deepEqual(selected.map(p=>p.name),['page-002-back.pdf','page-003-front.pdf','page-005-calibration.pdf']);
 assert.equal((await archive(route,{})).length,2);
 const native=await archive(route,{quality:'full',page_range:'1'});assert.deepEqual(native[0].widths,[745]);assert.deepEqual(native[0].heights,[1040]);
 assert.equal((await request(route,'POST',{packaging:'invalid'})).status,400);
 assert.equal((await request('/api/print-tray','POST',{items:[{version_id:version,art_set_id:deck.active_art_set_id,quantity:10}]})).status,201);
 const tray=await archive('/api/print/pdf',{});assert.deepEqual(tray.map(p=>p.name),['page-001.pdf','page-002.pdf']);
});

test('generation prompts prioritize single-line title fit over naming style requirements',async t=>{
 const {app,request}=await setup(t);app.queue.setPaused(true);
 const deck=(await request('/api/decks','POST',{name:'Title fit',style:'Always use a long ceremonial epithet.',decklist:'1 Sol Ring'})).data;
 const jobId=(await request(`/api/decks/${deck.id}/generate`,'POST',{})).data.jobs[0];
 const job=app.store.get('SELECT * FROM jobs WHERE id=?',jobId),saved=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json'),'utf8'));
 const prompt=app.queue.prompt(saved,path.join(job.directory,'request.json'));
 assert.match(prompt,/ONE LINE in the fixed title box/);
 assert.match(prompt,/shorten or omit epithets/);
 assert.match(prompt,/overrides naming requirements in deck guidelines and style prompts/);
 assert.match(prompt,/Check BOTH faces against the selected request.frame_set/);
});

test('each face prints as its own card for decks, saved versions and trays',async t=>{
 const {app,request,dir}=await setup(t);
 const deck=(await request('/api/decks','POST',{name:'Sleeved faces',decklist:'5 Sol Ring\n1 Forest'})).data;
 const card=deck.cards.find(c=>c.name==='Sol Ring'),single=deck.cards.find(c=>c.name==='Forest');
 const {execFileSync}=await import('node:child_process');
 const front=path.join(dir,'separate-front.png'),back=path.join(dir,'separate-back.png');
 execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(80,112),"red").save(sys.argv[1]);Image.new("RGB",(80,112),"blue").save(sys.argv[2])',front,back]);
 const version=app.store.addVersion(card.id,{image_path:front,summary:{name:card.name},faces:[{label:'back',image_path:back}]});
 app.store.addVersion(single.id,{image_path:front,summary:{name:single.name}});
 const route=`/api/decks/${deck.id}`,settings={face_mode:'separate',quality:'full',download_mode:'link'};
 const preview=await request(route+'/print-preview','POST',settings);
 assert.equal(preview.status,200);assert.equal(preview.data.count,11);assert.equal(preview.data.pages,2);
 const printed=await request(route+'/print.pdf','POST',settings);assert.equal(printed.status,200);
 const exportId=printed.data.download_url.split('/').at(-1);
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'exports',exportId+'.json'),'utf8'));
 assert.equal(saved.plan.count,11);assert.equal(saved.entries.length,2);assert.equal(saved.plan.face_mode,'separate');
 const history=await request(route+'/print-history','POST',{});assert.equal(history.data.settings.face_mode,'separate');assert.ok(history.data.saved_export);
 const selected=await request(route+'/print-preview','POST',{...settings,card_ids:[card.id],version_id:version,copies:1});
 assert.equal(selected.data.count,2);assert.equal(selected.data.pages,1);
 const tray=await request('/api/print-tray','POST',{items:[{version_id:version,art_set_id:deck.active_art_set_id,quantity:5}]});assert.equal(tray.status,201);
 const trayPreview=await request('/api/print/preview','POST',settings);assert.equal(trayPreview.data.count,10);assert.equal(trayPreview.data.pages,2);
 const split=await request('/api/print/pdf','POST',{...settings,packaging:'per_page',page_range:'2'});assert.equal(split.status,200);assert.equal(split.data.pages.length,1);assert.equal(split.data.pages[0].number,2);
});

test('completed print exports offer individual PDF links, stream stored members and recover older archives',async t=>{
 const {app,request,fetchLocal,url,dir}=await setup(t),deck=(await request('/api/decks','POST',{name:'Page links <test>',decklist:'10 Sol Ring'})).data,card=deck.cards[0];
 const {execFileSync}=await import('node:child_process');const source=path.join(dir,'page-link-source.png');
 execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(745,1040),"red").save(sys.argv[1])',source]);
 app.store.addVersion(card.id,{image_path:source,summary:{name:card.name}});
 const response=await request(`/api/decks/${deck.id}/print.pdf`,'POST',{packaging:'per_page',quality:'compact',download_mode:'link'});
 assert.equal(response.status,200);const info=response.data;assert.equal(info.pages.length,2);assert.match(info.filename,/-print-pages.zip$/);
 const exported=await fetchLocal(url+info.download_url);assert.equal(exported.headers.get('content-type'),'application/zip');const zip=Buffer.from(await exported.arrayBuffer());assert.equal(zip.subarray(0,2).toString(),'PK');
 const index=await fetchLocal(url+info.pages_url);assert.equal(index.status,200);assert.equal(index.headers.get('content-type'),'text/html; charset=utf-8');const html=await index.text();assert.match(html,/Open &amp; print/);assert.match(html,/&lt;test&gt;/);assert.doesNotMatch(html,/<test>/);
 for(const page of info.pages){
  const opened=await fetchLocal(url+page.view_url);assert.equal(opened.status,200);assert.equal(opened.headers.get('content-type'),'application/pdf');assert.equal(opened.headers.get('content-disposition'),null);
  const pdf=Buffer.from(await opened.arrayBuffer());assert.equal(pdf.length,page.size);assert.equal(pdf.subarray(0,4).toString(),'%PDF');assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,1);
  const downloaded=await fetchLocal(url+page.download_url);assert.match(downloaded.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pdf);
  const first=await fetchLocal(url+page.view_url,{headers:{Range:'bytes=0-7'}});assert.equal(first.status,206);assert.equal(first.headers.get('content-range'),`bytes 0-7/${pdf.length}`);assert.deepEqual(Buffer.from(await first.arrayBuffer()),pdf.subarray(0,8));
  const tail=await fetchLocal(url+page.view_url,{headers:{Range:'bytes=-6'}});assert.equal(tail.status,206);assert.deepEqual(Buffer.from(await tail.arrayBuffer()),pdf.subarray(-6));
  const invalid=await fetchLocal(url+page.view_url,{headers:{Range:`bytes=${pdf.length}-`}});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),`bytes */${pdf.length}`);
 }
 const exportId=info.download_url.split('/').at(-1),savedPath=path.join(dir,'exports',exportId+'.json'),saved=JSON.parse(fs.readFileSync(savedPath));delete saved.pages;fs.writeFileSync(savedPath,JSON.stringify(saved));
 const recovered=await request(info.download_url+'/pages');assert.equal(recovered.status,200);assert.deepEqual(recovered.data.pages,info.pages);assert.equal(JSON.parse(fs.readFileSync(savedPath)).pages.length,2);
 assert.equal((await fetchLocal(url+info.download_url+'/pages/999')).status,404);
 assert.equal((await fetchLocal(url+'/api/print-exports/not-a-uuid')).status,404);
 const combined=await request(`/api/decks/${deck.id}/print.pdf`,'POST',{quality:'compact',download_mode:'link'});assert.equal(combined.status,200);const pdf=await fetchLocal(url+combined.data.download_url);assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
});

test('print modal history restores matching exports, reuses files and isolates sets and selections',async t=>{
 const {app,request,dir}=await setup(t),deck=(await request('/api/decks','POST',{name:'Remember print',decklist:'2 Sol Ring\n1 Forest'})).data;
 const {execFileSync}=await import('node:child_process');const source=path.join(dir,'history-source.png');execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(745,1040),"red").save(sys.argv[1])',source]);
 for(const card of deck.cards)app.store.addVersion(card.id,{image_path:source,summary:{name:card.name}});
 const root=`/api/decks/${deck.id}`,settings={packaging:'per_page',quality:'compact',calibration:true,download_mode:'link'};
 assert.equal((await request(root+'/print-history','POST',{})).data.saved_export,null);
 const first=await request(root+'/print.pdf','POST',settings);assert.equal(first.status,200);const count=()=>fs.readdirSync(path.join(dir,'exports')).filter(name=>name.endsWith('.zip')).length;
 const before=count(),restored=await request(root+'/print-history','POST',{});assert.equal(restored.data.settings.packaging,'per_page');assert.equal(restored.data.settings.quality,'compact');assert.equal(restored.data.settings.calibration,true);assert.equal(restored.data.saved_export.download_url,first.data.download_url);
 assert.equal((await request(root+'/print-preview','POST',settings)).data.saved_export.download_url,first.data.download_url);
 const again=await request(root+'/print.pdf','POST',settings);assert.equal(again.data.reused,true);assert.equal(again.data.download_url,first.data.download_url);assert.equal(count(),before);
 assert.equal((await request(root+'/print-preview','POST',{...settings,quality:'600'})).data.saved_export,null);
 assert.equal((await request(root+'/print-history','POST',{card_ids:[deck.cards[0].id]})).data.saved_export,null);
 const firstSet=deck.active_art_set_id;app.store.artSets.create(deck.id,{name:'Alternate',mode:'copy'});assert.equal((await request(root+'/print-history','POST',{})).data.saved_export,null);app.store.artSets.activate(deck.id,firstSet);
 await request(`/api/cards/${deck.cards[0].id}`,'PATCH',{quantity:4});const stale=await request(root+'/print-history','POST',{});assert.equal(stale.data.saved_export,null);assert.equal(stale.data.changed,true);
 await request(`/api/cards/${deck.cards[0].id}`,'PATCH',{quantity:2});assert.equal((await request(root+'/print-history','POST',{})).data.saved_export.download_url,first.data.download_url);
 // The completed manifest also recovers exports made before the history index.
 app.store.run("DELETE FROM settings WHERE key LIKE 'print-export:%'");const migrated=await request(root+'/print-history','POST',{});assert.equal(migrated.data.saved_export.download_url,first.data.download_url);
});

test('Magic Set Editor templates import as ready frame sets without Codex',async t=>{
  const python=fileURLToPath(new URL('./fixtures/fake-mse-python.py',import.meta.url));fs.chmodSync(python,0o755);
  const {request,dir}=await setup(t,{python});
  const catalog=await request('/api/frame-templates');assert.equal(catalog.status,200);assert.deepEqual(catalog.data.templates.map(t=>[t.id,t.preview,t.frame_set_id]),[['m15-showcase-test',false,null],['m15-split-test',false,null]]);
  assert.equal((await request('/api/frame-sets/import-template','POST',{stylesheet:'m15-split-test'})).status,400);
  assert.equal((await request('/api/frame-sets/import-template','POST',{stylesheet:'nope'})).status,400);
  const created=await request('/api/frame-sets/import-template','POST',{stylesheet:'m15-showcase-test'});assert.equal(created.status,201,created.data.error);
  assert.equal(created.data.name,'Test Showcase — Test Deco');assert.equal(created.data.template_source,'m15-showcase-test');
  let set;const start=Date.now();while(Date.now()-start<20000){set=(await request('/api/frame-sets/'+created.data.id)).data;if(set.versions[0].status!=='running')break;await delay(40);}
  assert.equal(set.versions[0].status,'ready',set.versions[0].error);assert.equal(set.current_version_id,set.versions[0].id);
  assert.match(fs.readFileSync(set.versions[0].config_path,'utf8'),/"renderer": ?"mse"/);
  // Importing again opens the existing set; template sets are not regenerated by Codex.
  assert.equal((await request('/api/frame-sets/import-template','POST',{stylesheet:'m15-showcase-test'})).data.id,created.data.id);
  assert.equal((await request('/api/frame-templates')).data.templates[0].frame_set_id,created.data.id);
  assert.equal((await request('/api/frame-sets/'+created.data.id+'/generate','POST',{options:1})).status,400);
  fs.mkdirSync(path.join(dir,'mse','previews'),{recursive:true});fs.writeFileSync(path.join(dir,'mse','previews','m15-showcase-test.jpg'),'jpg');
  assert.equal((await request('/api/frame-templates')).data.templates[0].preview,true);
});
