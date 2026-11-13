import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {Store} from '../store.mjs';import {JobQueue} from '../runner.mjs';import {ArtStyles} from '../art-styles.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),fixture=path.join(root,'studio/tests/fixtures/fake-codex.py');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){const value=fn();if(value)return value;await delay(30);}throw new Error('Extraction did not finish');}
function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'art-styles-test-')),store=new Store(directory,{recover:false}),queue=new JobQueue(store,root,{binary:fixture}),styles=new ArtStyles(store,root,queue,()=>{},{binary:fixture,retryBaseMs:20});queue.setPaused(true);queue.styleSnapshot=(deck,dest,previous)=>styles.resolveDeck(deck,dest,previous);t.after(async()=>{styles.close();queue.close();while(styles.active||queue.active)await delay(20);store.close();fs.rmSync(directory,{recursive:true,force:true});});return {directory,store,queue,styles};}
const image=()=> 'data:image/png;base64,'+execFileSync('python3',['-c','from PIL import Image; import sys; Image.new("RGB",(128,160),(70,105,90)).save(sys.stdout.buffer,format="PNG")']).toString('base64');
const finished=async(styles,id)=>until(()=>{const j=styles.job(id);return ['succeeded','failed'].includes(j.status)&&j;});

test('reusable Styles pin revisions, preserve custom prompts and freeze card-job snapshots',async t=>{
 const {store,queue,styles}=setup(t);assert.equal(styles.list().length,3);
 const deck=store.createDeck({name:'Existing custom deck',style:'Cats and dogs. Gouache. Keep Oracle names.'},[{name:'Sol Ring',quantity:1}]);
 const before=fs.mkdtempSync(path.join(store.directory,'before-'));assert.equal(styles.resolveDeck(deck,before).text,deck.style);
 const style=styles.list()[0],revision=styles.revision(style.current_revision_id);styles.updateDeck(deck.id,{style_revision_id:revision.id});
 const jobs=queue.enqueue(deck.id,{}),job=store.get('SELECT * FROM jobs WHERE id=?',jobs[0]),frozen=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json')));
 assert.equal(frozen.style_context.style_revision.id,revision.id);const original=fs.readFileSync(path.join(job.directory,'style.txt'),'utf8');assert.ok(original.includes(deck.style));assert.ok(original.includes(revision.prompt));
 styles.update(style.id,{prompt:'New opaque layered paint and canvas texture.'});assert.equal(styles.deckGuidelines(deck.id).style_revision_id,revision.id);assert.equal(fs.readFileSync(path.join(job.directory,'style.txt'),'utf8'),original);
 styles.applyToDecks(style.id,{deck_ids:[deck.id]});assert.notEqual(styles.deckGuidelines(deck.id).style_revision_id,revision.id);assert.equal(styles.deckGuidelines(deck.id).custom_prompt,deck.style);
 const copy=store.duplicate(deck.id);assert.equal(copy.style_revision_id,styles.deckGuidelines(deck.id).style_revision_id);assert.equal(copy.style,deck.style);
 styles.update(style.id,{archived:true});assert.equal(styles.detail(style.id).archived,1);assert.doesNotThrow(()=>styles.resolveDeck(store.deck(deck.id),before));
});

test('style-only reference extraction filters non-style output, retains originals and snapshots removed references',async t=>{
 const {store,styles}=setup(t),style=styles.create({name:'Reference derived',prompt:'Initial hand-painted technique.'});
 await assert.rejects(styles.upload({owner_type:'style',owner_id:style.id,name:'bad.png',data:'data:image/png;base64,YWJjZA=='}));
 const ref=await styles.upload({owner_type:'style',owner_id:style.id,name:'reference.png',data:image()});assert.equal(ref.width,128);assert.ok(fs.existsSync(store.get('SELECT original_path FROM art_references WHERE id=?',ref.id).original_path));
 assert.throws(()=>styles.extract({owner_type:'style',owner_id:style.id,features:['characters']}));
 const job=styles.extract({owner_type:'style',owner_id:style.id,features:['art_style']}),done=await finished(styles,job.id);assert.equal(done.status,'succeeded',done.error);assert.deepEqual(Object.keys(done.result.sections),['art_style']);assert.equal(styles.detail(style.id).current_revision_id,style.current_revision_id);
 const applied=styles.apply(job.id,{sections:{art_style:'Editable extracted brushwork and paper texture.'}}),revision=styles.revision(applied.revision_id);assert.deepEqual(revision.reference_ids,[ref.id]);assert.throws(()=>styles.apply(job.id,{}));
 styles.removeReference(ref.id);assert.equal(styles.detail(style.id).references.length,0);
 const deck=store.createDeck({name:'Pinned references',style_revision_id:revision.id}),directory=fs.mkdtempSync(path.join(store.directory,'snapshot-')),snapshot=styles.resolveDeck(deck,directory);assert.equal(snapshot.snapshot.reference_images.length,1);assert.ok(fs.existsSync(snapshot.snapshot.reference_images[0].path));assert.equal(snapshot.snapshot.reference_images[0].scope,'reusable_art_style');
 const immutable=fs.readFileSync(snapshot.snapshot.reference_images[0].path);assert.ok(immutable.length>0);
});

test('deck extraction merges only selected sections and custom mode appends without losing existing guidance',async t=>{
 const {store,styles}=setup(t),deck=store.createDeck({name:'Structured world',style:'Original unrestricted custom prompt.'});
 styles.updateDeck(deck.id,{mode:'structured',sections:{art_style:'Original brushwork.',naming_flavor:'Keep original names.',world:'Original world.'}});
 const ref=await styles.upload({owner_type:'deck',owner_id:deck.id,name:'deck-ref.png',data:image()});assert.deepEqual(ref.features,[]);
 const job=styles.extract({owner_type:'deck',owner_id:deck.id,features:['composition','characters'],reference_ids:[ref.id]});assert.equal((await finished(styles,job.id)).status,'succeeded');
 styles.updateDeck(deck.id,{sections:{...styles.deckGuidelines(deck.id).sections,world:'Updated while analysis ran.'}});
 styles.apply(job.id,{apply_mode:'structured',sections:{composition:'Wide camera views.',characters:'Consistent character proportions.',world:'Unselected content must be ignored.'}});
 const saved=styles.deckGuidelines(deck.id);assert.equal(saved.sections.world,'Updated while analysis ran.');assert.equal(saved.sections.art_style,'Original brushwork.');assert.equal(saved.sections.naming_flavor,'Keep original names.');assert.equal(saved.sections.composition,'Wide camera views.');assert.equal(saved.custom_prompt,deck.style);
 const second=styles.extract({owner_type:'deck',owner_id:deck.id,features:['lighting']});assert.equal((await finished(styles,second.id)).status,'succeeded');styles.apply(second.id,{apply_mode:'custom',sections:{lighting:'Soft diffuse illumination.'}});assert.match(styles.deckGuidelines(deck.id).custom_prompt,/Original unrestricted custom prompt/);assert.match(styles.deckGuidelines(deck.id).custom_prompt,/Soft diffuse illumination/);
});

test('extraction retries model capacity and preserves separate attempts',async t=>{
 const {styles}=setup(t),style=styles.create({name:'Capacity extraction',prompt:'Paper texture.'});await styles.upload({owner_type:'style',owner_id:style.id,name:'ref.png',data:image()});
 const job=styles.extract({owner_type:'style',owner_id:style.id,instructions:'RATE_LIMIT_ONCE'}),done=await finished(styles,job.id);assert.equal(done.status,'succeeded',done.error);assert.equal(done.retry_count,1);assert.ok(fs.existsSync(path.join(done.directory,'attempt-1/events.jsonl')));assert.ok(fs.existsSync(path.join(done.directory,'attempt-2/result.json')));
});

test('frame snapshots copy raster ornaments into the job and retain their hashes',async t=>{
 const {directory}=setup(t);const {copyFrameSet}=await import('../frame-assets.mjs');const source=path.join(directory,'frame-source'),target=path.join(directory,'card-job');fs.mkdirSync(source);fs.mkdirSync(target);const config=JSON.parse(fs.readFileSync(path.join(root,'examples/frame-set.json')));fs.writeFileSync(path.join(source,'ornament.png'),Buffer.from(image().split(',')[1],'base64'));config.decorations=[{image:'ornament.png',box:[0,0,100,100]}];fs.writeFileSync(path.join(source,'config.json'),JSON.stringify(config));copyFrameSet(path.join(source,'config.json'),path.join(target,'frame-set.json'));const frozen=JSON.parse(fs.readFileSync(path.join(target,'frame-set.json')));assert.ok(frozen.decorations[0].sha256);const snapshot=path.join(target,frozen.decorations[0].image),original=fs.readFileSync(snapshot);fs.writeFileSync(path.join(source,'ornament.png'),'changed');assert.deepEqual(fs.readFileSync(snapshot),original);
});

test('Grok cooldowns do not stop Codex reference analysis',async t=>{
 const {queue,styles}=setup(t);queue.setProviderCooldown('grok-cli',Date.now()+60000);
 const style=styles.create({name:'Independent analysis',prompt:'Watercolour texture.'});await styles.upload({owner_type:'style',owner_id:style.id,name:'ref.png',data:image()});
 const job=styles.extract({owner_type:'style',owner_id:style.id});assert.equal((await finished(styles,job.id)).status,'succeeded');assert.equal(queue.cooldownFor('codex'),0);
});
test('frame snapshots also copy painted panel skins so card jobs can render them',async t=>{
 const {directory}=setup(t);const {copyFrameSet}=await import('../frame-assets.mjs');const source=path.join(directory,'skin-source'),target=path.join(directory,'skin-job');fs.mkdirSync(source);fs.mkdirSync(target);
 const config=JSON.parse(fs.readFileSync(path.join(root,'examples/frame-set.json')));fs.writeFileSync(path.join(source,'leather.png'),Buffer.from(image().split(',')[1],'base64'));config.skins={leather:{image:'leather.png'}};config.style.title_skin='leather';
 fs.writeFileSync(path.join(source,'config.json'),JSON.stringify(config));copyFrameSet(path.join(source,'config.json'),path.join(target,'frame-set.json'));
 const frozen=JSON.parse(fs.readFileSync(path.join(target,'frame-set.json')));assert.ok(frozen.skins.leather.sha256);assert.ok(fs.existsSync(path.join(target,frozen.skins.leather.image)));assert.notEqual(frozen.skins.leather.image,'leather.png');
});
