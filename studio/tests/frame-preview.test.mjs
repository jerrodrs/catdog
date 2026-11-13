import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Store} from '../store.mjs';import {FrameStudio} from '../frame-studio.mjs';import {frameSamples,paletteFamily} from '../frame-preview.mjs';
const card=(id,colors,type_line,extra={})=>({id,name:id,active_version_id:'v-'+id,art_mode:'custom',section:'main',entry_kind:'card',token_spec:{},summary:{id,colors,type_line},...extra});
test('deck frame previews take one custom card per palette in the deck plus a legendary card',()=>{
 const deck={cards:[
  card('Okaun',['R'],'Legendary Creature — Cyclops',{section:'commander'}),card('Goblin',['R'],'Creature — Goblin'),card('Brainstorm',['U'],'Instant'),
  card('Polarity',['U','R'],'Instant'),card('Locust',['U','R'],'Legendary Creature — God'),card('Signet',[],'Artifact'),card('Mesa',[],'Land'),
  card('Scan',['G'],'Creature — Elf',{art_mode:'official'}),card('Blank',['W'],'Creature — Cat',{active_version_id:null})]};
 const samples=frameSamples(deck);
 assert.deepEqual(samples.map(s=>[s.key,s.name]),[['U','Brainstorm'],['R','Goblin'],['multicolour','Polarity'],['C','Signet'],['legendary','Okaun']]);
 assert.equal(samples.find(s=>s.key==='multicolour').label,'Blue–Red');assert.match(samples.at(-1).label,/commander/);
 assert.equal(paletteFamily(card('x',['W','U','B'],'Instant')),'M');assert.equal(paletteFamily(card('y',['G','W'],'Instant')),'GW');
 assert.deepEqual(frameSamples({cards:[card('Scan',['G'],'Creature',{art_mode:'official'})]}),[]);
});
test('Frame Studio real-art proofs use generated custom art matched to the card structure, with fallbacks',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frame-art-')),store=new Store(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const frames=new FrameStudio(store,path.resolve('.'),{cooldownFor:()=>0},()=>{});
 const deck=store.createDeck({name:'Art'},[{name:'Cat',quantity:1},{name:'Sol Ring',quantity:1},{name:'Scan',quantity:1}]);
 const add=(name,summary,source_type='custom')=>{const c=store.deck(deck.id).cards.find(x=>x.name===name),dir=path.join(directory,'v-'+name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'art.png'),'');const id=store.addVersion(c.id,{image_path:path.join(dir,'art.png'),manifest_path:path.join(dir,'manifest.json'),summary:{id:name,art:'art.png',...summary}});store.run('UPDATE versions SET source_type=? WHERE id=?',source_type,id);return id;};
 const cat=add('Cat',{type_line:'Creature — Cat'}),ring=add('Sol Ring',{type_line:'Artifact'});add('Scan',{type_line:'Creature — Elf'},'official');
 assert.deepEqual(frames.artCandidates('creature').rows.map(r=>r.id),[cat]);
 assert.equal(frames.sampleArt('artifact').version_id,ring);
 const token=frames.sampleArt('token');assert.equal(token.version_id,cat);assert.equal(token.matched,false);assert.equal(token.matched_kind,'creature');
 assert.equal(frames.sampleArt('creature',cat).version_id,cat,'a single candidate is still returned when excluded');
 assert.throws(()=>frames.sampleArt('nonsense'),/supported card structure/);
});
test('Frame Studio real-art proofs can draw only from one deck artwork set, active or not',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frame-art-set-')),store=new Store(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const frames=new FrameStudio(store,path.resolve('.'),{cooldownFor:()=>0},()=>{});
 const vegas=store.createDeck({name:'Vegas'},[{name:'Cat',quantity:1}]),forest=store.createDeck({name:'Forest'},[{name:'Bear',quantity:1}]);
 const add=(deck,name,options)=>{const c=store.deck(deck.id).cards.find(x=>x.name===name),dir=fs.mkdtempSync(path.join(directory,'v-'));fs.writeFileSync(path.join(dir,'art.png'),'');return store.addVersion(c.id,{image_path:path.join(dir,'art.png'),manifest_path:path.join(dir,'manifest.json'),summary:{art:'art.png',type_line:'Creature — '+name}},options);};
 const cat=add(vegas,'Cat'),bear=add(forest,'Bear'),active=store.artSets.ensure(vegas.id);
 const inactive='inactive-set';store.run('INSERT INTO deck_art_sets(id,deck_id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',inactive,vegas.id,'Neon',JSON.stringify({}),'now','now');
 const neon=add(vegas,'Cat',{artSetId:inactive,activate:false});store.run('INSERT INTO deck_art_cards(set_id,card_id,version_id,state_json) VALUES(?,?,?,?)',inactive,store.deck(vegas.id).cards[0].id,neon,'{}');
 assert.deepEqual(frames.artCandidates('creature').rows.map(r=>r.id).sort(),[bear,cat,neon].sort());
 assert.deepEqual(frames.artCandidates('creature',active).rows.map(r=>r.id),[cat]);
 const picked=frames.sampleArt('creature','',inactive);assert.equal(picked.version_id,neon);assert.equal(picked.art_set_id,inactive);assert.equal(picked.deck_name,'Vegas · Neon');
 assert.equal(frames.sampleArt('token','',store.artSets.ensure(forest.id)).version_id,bear);
 const empty=store.createDeck({name:'Empty'},[{name:'Ox',quantity:1}]);assert.throws(()=>frames.sampleArt('creature','',store.artSets.ensure(empty.id)),/no custom illustrations/);
});

import {DeckFramePreview} from '../frame-preview.mjs';
function previewSetup(t,{mse=false,runner=null}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deck-preview-')),store=new Store(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const deck=store.createDeck({name:'Preview'},[{name:'Red',quantity:1},{name:'Blue',quantity:1},{name:'Artifact',quantity:1}]);
 for(const [i,c] of deck.cards.entries()){
  const folder=path.join(directory,c.id);fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'art.png'),'saved-art');
  const summary={id:c.id,name:c.name,art:'art.png',colors:i===0?['R']:i===1?['U']:[],type_line:'Creature — Test',oracle_text:'Draw a card.',power:'2',toughness:'3'};
  const manifest=path.join(folder,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({cards:[summary]}));store.addVersion(c.id,{image_path:path.join(folder,'art.png'),manifest_path:manifest,summary});
 }
 const config=path.join(directory,'frame.json');fs.writeFileSync(config,JSON.stringify({renderer:mse?'mse':'native'}));
 const calls=[],frames={snapshot:id=>({id,name:id,version_id:id+'-v1',config_path:config,rules_sizing:'fit'})},borders={code:'border-v1',settings:()=>({style:'black',width_mm:1.2})};
 const render=async(python,args,options)=>{
  const request=JSON.parse(fs.readFileSync(args[1]));calls.push(request);
  const finish=()=>{const jobs=request.jobs||[request];for(const job of jobs)fs.writeFileSync(job.destination,'PNG proof');return {stdout:JSON.stringify({results:jobs.map(job=>({image_path:job.destination}))})};};
  return runner?runner({request,options,finish,calls}):finish();
 };
 const preview=new DeckFramePreview(store,path.resolve('.'),frames,borders,{runPreview:render});return {directory,store,deck:store.deck(deck.id),preview,calls};
}

test('preview cache includes source changes and borders, applies the border in the same worker and deduplicates concurrent requests',async t=>{
 const {store,deck,preview,calls}=previewSetup(t);const card=deck.cards[0],listed=preview.list(deck,'frame-A','dialog',1),key=listed.samples.find(sample=>sample.card_id===card.id).preview_key;
 const results=await Promise.all([preview.image(deck,'frame-A',card.id,{session:'dialog'}),preview.image(deck,'frame-A',card.id,{session:'dialog'})]);
 assert.equal(calls.length,1);assert.equal(results[0],results[1]);assert.equal(calls[0].width,900);assert.equal(calls[0].border_settings.style,'black');
 await preview.image(deck,'frame-A',card.id,{session:'dialog'});assert.equal(calls.length,1);
 const version=store.get('SELECT * FROM versions WHERE id=?',card.active_version_id);fs.appendFileSync(version.image_path,'new pixels');
 await assert.rejects(preview.image(deck,'frame-A',card.id,{session:'dialog',expectedKey:key}),/inputs changed/);
 await preview.image(deck,'frame-A',card.id,{session:'dialog'});assert.equal(calls.length,2);
});

test('MSE samples are prefetched and batched into one worker instead of one Windows launch per image',async t=>{
 const {deck,preview,calls}=previewSetup(t,{mse:true});const listed=preview.list(deck,'mse-frame','dialog',1);
 await Promise.all(listed.samples.map(sample=>preview.image(deck,'mse-frame',sample.card_id,{session:'dialog',expectedKey:sample.preview_key})));
 assert.equal(calls.length,1);assert.equal(calls[0].jobs.length,3);assert.ok(calls[0].jobs.every(job=>job.width===900));
});

test('rapid switching drops obsolete queued work and late metadata cannot undo the newest selection',async t=>{
 let release;
 const {deck,preview,calls}=previewSetup(t,{runner:({finish,calls})=>calls.length===1?new Promise(resolve=>{release=()=>resolve(finish());}):finish()});preview.limits.native=1;
 preview.list(deck,'A','dialog',1);
 const first=preview.image(deck,'A',deck.cards[0].id,{session:'dialog'});
 const old=preview.image(deck,'A',deck.cards[1].id,{session:'dialog'});const rejected=assert.rejects(old,/different frame/);
 preview.list(deck,'B','dialog',3);preview.list(deck,'A','dialog',2);
 const latest=preview.image(deck,'B',deck.cards[1].id,{session:'dialog'});release();
 await Promise.all([first,rejected,latest]);assert.equal(calls.length,2);
});
