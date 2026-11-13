import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../store.mjs';
import {OfficialPrintings,printingFaces,imageKind} from '../official-printings.mjs';
import {JobQueue} from '../runner.mjs';
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',O='cccccccc-cccc-cccc-cccc-cccccccccccc';
const card={id:A,oracle_id:O,name:'Sol Ring',set:'test',set_name:'Test set',collector_number:'1',type_line:'Artifact',oracle_text:'{T}: Add {C}{C}.',artist:'An artist',scryfall_uri:'https://scryfall.com/card/test/1',image_uris:{normal:'https://cards.scryfall.io/normal/front/test.jpg',png:'https://cards.scryfall.io/png/front/test.png'}};
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-printings-')),store=new Store(dir);const deck=store.createDeck({name:'Originals'},[{name:'Sol Ring',quantity:1,section:'main'}]);const target=store.deck(deck.id).cards[0];store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify({name:'Sol Ring',oracle_id:O}),target.id);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,deck,target};}
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
function png(){return execFileSync('python3',['-c',"from PIL import Image; import io,sys; b=io.BytesIO(); Image.new('RGBA',(745,1040),(50,100,50,255)).save(b,format='PNG'); sys.stdout.buffer.write(b.getvalue())"]);}
test('official scan selection preserves history, native pixels and source mode on rollback; custom switch restores custom',async t=>{
 const {dir,store,target,deck}=setup(t),bytes=png(),calls=[];
 const service=new OfficialPrintings(store,{gap:0,fetcher:async url=>{calls.push(url);if(url.includes('scryfall.io'))return new Response(bytes,{headers:{'Content-Type':'image/png'}});return json({data:[card],total_cards:1,has_more:false});}});
 const custom=store.addVersion(target.id,{image_path:path.join(dir,'old.png'),summary:{name:'Sol Ring'}});
 const first=await service.catalog(target.id);await service.catalog(target.id);assert.equal(first.cards.length,1);assert.equal(calls.length,1,'catalog cached');
 const result=await service.select(target.id,A),saved=store.versions(target.id)[0];assert.equal(saved.source_type,'official');assert.equal(saved.art_provider,'official');assert.equal(saved.faces[0].width,745);assert.equal(saved.faces[0].dpi,300);assert.equal(store.deck(deck.id).cards[0].art_mode,'official');assert.equal(store.versions(target.id).length,2);assert.ok(fs.existsSync(saved.image_path));
 await service.image(A,0,'png');assert.equal(calls.length,2,'image cached');
 store.activate(target.id,custom);assert.equal(store.deck(deck.id).cards[0].art_mode,'custom');store.activate(target.id,result.version_id);service.useCustom(target.id);assert.equal(store.deck(deck.id).cards[0].active_version_id,custom);
 const other=store.createDeck({name:'Other'},[{name:'Sol Ring',quantity:1,section:'main'}]);assert.equal(store.deck(other.id).cards[0].active_version_id,null,'no automatic reuse across decks');
});
test('double faced scans save both faces; adventures use one physical full-card image',async t=>{
 const {store,target}=setup(t),bytes=png(),double={...card,image_uris:undefined,layout:'transform',card_faces:[{name:'Front',image_uris:card.image_uris},{name:'Back',image_uris:{png:'https://cards.scryfall.io/png/back/test.png'}}]};
 const service=new OfficialPrintings(store,{gap:0,fetcher:async()=>new Response(bytes,{headers:{'Content-Type':'image/png'}})});service.save(double);await service.select(target.id,A);const v=store.versions(target.id)[0];assert.equal(v.faces.length,2);assert.equal(v.faces[1].label,'back');assert.ok(fs.existsSync(v.faces[1].image_path));
 assert.equal(printingFaces({...card,layout:'adventure',card_faces:[{name:'Creature'},{name:'Adventure'}]}).length,1);
});
test('identity, active job, arbitrary hosts and invalid printing IDs are rejected',async t=>{
 const {store,target,dir}=setup(t),service=new OfficialPrintings(store,{gap:0,fetcher:async()=>{throw Error('unexpected fetch');}});service.save({...card,id:B,oracle_id:B,name:'Wrong card'});await assert.rejects(service.select(target.id,B),/same Magic card/);await assert.rejects(service.printing('../bad'),/valid Scryfall/);
 service.save({...card,image_uris:{png:'https://example.com/private'}});await assert.rejects(service.image(A,0,'png'),/Untrusted/);
 store.run("INSERT INTO jobs(id,deck_id,card_id,type,status,version_id,directory,created_at) VALUES('job',?,?,'generate','queued','v',?,'now')",target.deck_id,target.id,dir);await assert.rejects(service.select(target.id,A),/generation/);assert.throws(()=>service.useCustom(target.id),/generation/);
});
test('official mode without earlier custom versions switches to a fresh custom card; generation skips official cards',async t=>{
 const {store,target,deck,dir}=setup(t),service=new OfficialPrintings(store,{gap:0,fetcher:async()=>new Response(png(),{headers:{'Content-Type':'image/png'}})});service.save(card);await service.select(target.id,A);
 const queue=new JobQueue(store,path.resolve('.'),{});queue.paused=true;t.after(()=>queue.close());assert.deepEqual(queue.enqueue(deck.id,{mode:'all'}),[]);assert.throws(()=>queue.enqueue(deck.id,{card_ids:[target.id],mode:'selected',type:'revise'}),/Switch this card/);
 service.useCustom(target.id);const current=store.deck(deck.id).cards[0];assert.equal(current.active_version_id,null);assert.equal(current.art_mode,'custom');assert.equal(store.versions(target.id).length,1);
});
test('generate missing treats real MTG art as missing custom art, starting fresh from the scan',async t=>{
 const {store,target,deck}=setup(t),service=new OfficialPrintings(store,{gap:0,fetcher:async()=>new Response(png(),{headers:{'Content-Type':'image/png'}})});service.save(card);await service.select(target.id,A);
 const queue=new JobQueue(store,path.resolve('.'),{});queue.paused=true;t.after(()=>queue.close());
 assert.deepEqual(queue.enqueue(deck.id,{card_ids:[target.id],mode:'selected'}),[]);
 const jobs=queue.enqueue(deck.id,{mode:'missing',include_history:true});assert.equal(jobs.length,1);
 const job=store.get('SELECT * FROM jobs WHERE id=?',jobs[0].id??jobs[0]),request=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json'),'utf8'));
 assert.equal(request.previous_version,null);assert.equal(store.deck(deck.id).cards[0].art_mode,'official');
 assert.deepEqual(queue.enqueue(deck.id,{mode:'missing'}),[]);
 queue.cancel(job.id);assert.equal(queue.retry(job.id).length,1);
});
test('API rate limits back off without repeated requests, stale catalog works offline',async t=>{
 const {store,target}=setup(t);let calls=0;const service=new OfficialPrintings(store,{gap:0,fetcher:async()=>{calls++;return new Response(JSON.stringify({details:'slow down'}),{status:429});}});await assert.rejects(service.catalog(target.id),/rate limiting/);await assert.rejects(service.catalog(target.id),/rate limiting/);assert.equal(calls,1);
 service.cooldown=0;service.fetcher=async()=>json({data:[card],total_cards:1});await service.catalog(target.id);store.run("UPDATE official_catalog_pages SET updated_at='2000-01-01'");service.fetcher=async()=>{throw Error('offline');};const cached=await service.catalog(target.id);assert.equal(cached.stale,true);assert.equal(cached.cards.length,1);
});

test('pending exact printings survive restart and legacy official selections acquire printing identity',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-restart-'));let store=new Store(dir);const deck=store.createDeck({name:'Persistent'},[{name:'Sol Ring',quantity:1,section:'main',printing:{set:'test',collector_number:'1'}}]);
 const pending=deck.cards[0];store.close();store=new Store(dir);
 const bytes=png(),printing={...card,lang:'en'};const service=new OfficialPrintings(store,{gap:0,fetcher:async url=>url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):json(printing)});
 t.after(async()=>{await service.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});service.schedule();for(let i=0;i<100&&!store.deck(deck.id).cards[0].active_version_id;i++)await new Promise(r=>setTimeout(r,20));assert.ok(store.deck(deck.id).cards[0].active_version_id);await service.close();
 store.db.exec('ALTER TABLE cards DROP COLUMN printing_json; ALTER TABLE cards DROP COLUMN printing_error');store.close();store=new Store(dir);assert.deepEqual(JSON.parse(store.deck(deck.id).cards[0].printing_json),{set:'test',collector_number:'1'});assert.equal(store.deck(deck.id).cards[0].id,pending.id);
});

test('Populate MTG art queues blanks once, preserves artwork and live jobs, and stays within the selected artwork set',async t=>{
 const {store,target,deck,dir}=setup(t),service=new OfficialPrintings(store,{gap:0});service.schedule=()=>{};
 const existing=store.addCard(deck.id,{name:'Forest',quantity:2}),busy=store.addCard(deck.id,{name:'Mountain',quantity:1});store.addVersion(existing,{image_path:path.join(dir,'existing.png'),summary:{name:'Forest'}});store.run("INSERT INTO jobs(id,deck_id,card_id,type,status,version_id,directory,created_at) VALUES('live',?,?,'generate','queued','v',?,'now')",deck.id,busy,dir);
 assert.equal(service.populate(deck.id,{art_set_id:deck.active_art_set_id}).queued,1);assert.equal(service.populate(deck.id).queued,0);assert.deepEqual(JSON.parse(store.get('SELECT printing_json FROM cards WHERE id=?',target.id).printing_json),{first_available:true});assert.ok(store.get('SELECT active_version_id FROM cards WHERE id=?',existing).active_version_id);assert.equal(store.get('SELECT art_mode FROM cards WHERE id=?',busy).art_mode,'custom');assert.throws(()=>service.populate(deck.id,{art_set_id:'wrong'}),/changed/);
 store.run("UPDATE jobs SET status='cancelled' WHERE id='live'");store.run("UPDATE cards SET printing_error='test pending' WHERE id=?",target.id);const other=store.artSets.create(deck.id,{name:'Another',mode:'fresh'});assert.equal(store.deck(deck.id).cards[0].art_mode,'custom');assert.equal(service.populate(deck.id).queued,3);for(const c of store.deck(deck.id).cards)store.run("UPDATE cards SET printing_error='test paused' WHERE id=?",c.id);store.artSets.activate(deck.id,deck.active_art_set_id);assert.equal(store.get('SELECT printing_error FROM cards WHERE id=?',target.id).printing_error,'test pending');assert.notEqual(other.id,deck.active_art_set_id);
});
test('automatic official artwork chooses the first matching available scan and saves a version without AI',async t=>{
 const {store,target,deck}=setup(t),bytes=png(),missing={...card,id:B,image_status:'missing'},placeholder={...card,id:'dddddddd-dddd-dddd-dddd-dddddddddddd',image_status:'placeholder'},service=new OfficialPrintings(store,{gap:0,fetcher:async url=>url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):json({data:[missing,placeholder,card],has_more:false,total_cards:3})});service.schedule=()=>{};
 assert.equal(service.populate(deck.id).queued,1);await service.importNext();const saved=store.versions(target.id)[0];assert.equal(saved.source_type,'official');assert.equal(saved.summary.id,A);assert.equal(saved.faces[0].width,745);assert.equal(store.jobs(deck.id).length,0);assert.equal(store.get('SELECT printing_error FROM cards WHERE id=?',target.id).printing_error,'');assert.equal(service.populate(deck.id).queued,0);
});
test('failed automatic lookup keeps a retryable request and can recover',async t=>{
 const {store,target,deck}=setup(t),bytes=png();let fail=true;const service=new OfficialPrintings(store,{gap:0,fetcher:async url=>{if(fail)throw Error('offline');return url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):json({data:[card],total_cards:1});}});service.schedule=()=>{};service.populate(deck.id);await service.importNext();assert.match(store.get('SELECT printing_error FROM cards WHERE id=?',target.id).printing_error,/reach Scryfall/);assert.equal(store.versions(target.id).length,0);fail=false;service.retryImport(target.id);await service.importNext();assert.equal(store.versions(target.id).length,1);
});
test('Populate MTG art honours Scryfall prefer: and treatment choices, falling back when the treatment is unavailable',async t=>{
 const {store,target,deck}=setup(t),bytes=png(),oldest={...card,id:B,set:'lea',collector_number:'269'},queries=[];
 const service=new OfficialPrintings(store,{gap:0,fetcher:async url=>{if(url.includes('scryfall.io'))return new Response(bytes,{headers:{'Content-Type':'image/png'}});const params=new URL(url).searchParams;queries.push({q:params.get('q'),unique:params.get('unique')});
  if(/is:borderless/.test(params.get('q')))return new Response(JSON.stringify({object:'error',details:'Your query didn’t match any cards.'}),{status:404});
  return json({data:[/prefer:oldest/.test(params.get('q'))?oldest:card],has_more:false,total_cards:1});}});service.schedule=()=>{};
 assert.throws(()=>service.populate(deck.id,{prefer:'bogus'}),/Invalid art preference/);assert.throws(()=>service.populate(deck.id,{treatment:'is:foil'}),/Invalid art treatment/);
 assert.equal(service.populate(deck.id,{prefer:'oldest',treatment:'borderless'}).queued,1);assert.deepEqual(JSON.parse(store.get('SELECT printing_json FROM cards WHERE id=?',target.id).printing_json),{first_available:true,prefer:'oldest',treatment:'borderless'});
 await service.importNext();assert.equal(store.versions(target.id)[0].summary.id,B,'preferred printing used once the treatment search finds nothing');
 assert.deepEqual(queries,[{q:`oracleid:${O} game:paper lang:en is:borderless prefer:oldest`,unique:'cards'},{q:`oracleid:${O} game:paper lang:en is:borderless`,unique:'prints'},{q:`oracleid:${O} game:paper lang:en prefer:oldest`,unique:'cards'}]);
});

test('maximum quality uses the native PNG, explicit scan sizes persist and missing sizes fall back',async t=>{
 const {store,target,deck}=setup(t),bytes=png(),calls=[];
 const service=new OfficialPrintings(store,{gap:0,fetcher:async url=>{calls.push(url);return new Response(bytes,{headers:{'Content-Type':'image/png'}});}});
 const printing={...card,image_uris:{...card.image_uris,large:'https://cards.scryfall.io/large/front/test.jpg'}};service.save(printing);
 for(const [quality,kind]of [['max','png'],['large','large'],['normal','normal']]){
  await service.select(target.id,A,{quality});const saved=store.versions(target.id)[0];
  assert.equal(saved.summary.official_printing.image_quality,quality);assert.equal(saved.faces[0].source_format,kind);
  assert.ok(calls.at(-1).includes('/'+kind+'/'));assert.equal(saved.faces[0].width,745,'preserves native pixels without upscaling');
 }
 assert.equal(imageKind({image_uris:{large:'x'}},'max'),'large');
 assert.equal(imageKind({image_uris:{png:'x'}},'normal'),'png');
 await assert.rejects(service.select(target.id,A,{quality:'4k'}),/image quality/);
 assert.throws(()=>service.populate(deck.id,{quality:'4k'}),/image quality/);
 const fresh=store.addCard(deck.id,{name:'Sol Ring',quantity:1},{separate:true});service.schedule=()=>{};
 service.populate(deck.id,{quality:'normal',prefer:'oldest'});
 assert.equal(JSON.parse(store.get('SELECT printing_json FROM cards WHERE id=?',fresh).printing_json).quality,'normal');
});
test('swap MTG art re-picks printings for scan and reconstructed cards, keeping current art until saved',async t=>{
 const {store,target,deck}=setup(t),bytes=png(),newer={...card,id:B,set:'new',set_name:'Newer set',collector_number:'9'};let fail=false;
 const service=new OfficialPrintings(store,{gap:0,fetcher:async url=>{if(fail)throw Error('offline');return url.includes('scryfall.io')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):json({data:[newer],total_cards:1,has_more:false});}});service.schedule=()=>{};
 const built=[];service.reconstruction={create:async(cardId,{printing_id})=>{built.push(printing_id);return {version_id:store.addVersion(cardId,{image_path:'r.png',source_type:'reconstructed',art_provider:'official',summary:{}})};}};
 service.save(card);await service.select(target.id,A);const scan=store.deck(deck.id).cards[0].active_version_id;
 assert.throws(()=>service.swap(deck.id,{format:'bogus'}),/Choose original/);assert.throws(()=>service.swap(deck.id,{art_set_id:'wrong'}),/changed/);
 // Same printing + same format: nothing new is saved and the flag is cleared.
 store.run("UPDATE cards SET printing_json=? WHERE id=?",JSON.stringify({first_available:true,swap:true,format:'official'}),target.id);service.firstAvailable=async()=>card;await service.importNext();assert.equal(store.versions(target.id).length,1);assert.deepEqual(JSON.parse(store.deck(deck.id).cards[0].printing_json),{set:'test',collector_number:'1'});delete service.firstAvailable;
 // A failed swap keeps the current image, reports the error, and can be retried or dismissed.
 assert.equal(service.swap(deck.id,{art_set_id:deck.active_art_set_id,prefer:'oldest'}).queued,1);assert.deepEqual(JSON.parse(store.deck(deck.id).cards[0].printing_json),{first_available:true,swap:true,format:'official',prefer:'oldest'});
 fail=true;await service.importNext();let current=store.deck(deck.id).cards[0];assert.match(current.printing_error,/reach Scryfall/);assert.equal(current.active_version_id,scan);assert.equal(service.pending(),undefined);
 service.cancelSwap(target.id);current=store.deck(deck.id).cards[0];assert.deepEqual(JSON.parse(current.printing_json),{set:'test',collector_number:'1'});assert.equal(current.printing_error,'');assert.throws(()=>service.cancelSwap(target.id),/no MTG art swap/);
 service.swap(deck.id);fail=true;await service.importNext();fail=false;service.retryImport(target.id);await service.importNext();current=store.deck(deck.id).cards[0];
 assert.notEqual(current.active_version_id,scan);assert.equal(store.versions(target.id)[0].summary.id,B);assert.equal(current.art_mode,'official');assert.deepEqual(JSON.parse(current.printing_json),{set:'new',collector_number:'9'});assert.equal(store.versions(target.id).length,2);
 // Switching every MTG card to the reconstructed format; custom-art cards are never touched.
 assert.equal(service.swap(deck.id,{format:'reconstructed'}).queued,1);await service.importNext();current=store.deck(deck.id).cards[0];assert.deepEqual(built,[B]);assert.equal(current.art_mode,'reconstructed');assert.equal(current.printing_json,'{}');
 store.run("UPDATE cards SET art_mode='custom' WHERE id=?",target.id);assert.equal(service.swap(deck.id).queued,0);
});
