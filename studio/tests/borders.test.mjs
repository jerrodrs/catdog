import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {Store} from '../store.mjs';import {BorderFinish,borderSettings} from '../borders.mjs';
function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'outer-borders-')),store=new Store(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});const deck=store.createDeck({name:'Borders'},[{name:'Sol Ring',quantity:1}]),card=deck.cards[0],source=path.join(directory,'source.png');execFileSync('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(745,1040),"orange").save(sys.argv[1])',source]);const versionId=store.addVersion(card.id,{image_path:source,summary:{name:'Sol Ring'}}),version=store.get('SELECT * FROM versions WHERE id=?',versionId),finish=new BorderFinish(store,path.resolve('.'));return {store,deck,card,source,version,finish};}
test('border settings support inheritance and true zero, and reject invalid widths/styles',()=>{assert.deepEqual(borderSettings({}, {inherit:true}),{});assert.deepEqual(borderSettings({style:'modern',width_mm:0}),{style:'none',width_mm:0});assert.equal(borderSettings({style:'classic'}).width_mm,2);for(const v of [{style:'unknown'},{style:'black',width_mm:-1},{style:'black',width_mm:9},{style:'black',extra:true}])assert.throws(()=>borderSettings(v));});
test('finished PNGs are cached, source files stay immutable, and zero returns original bytes',async t=>{const {store,deck,source,version,finish}=setup(t),before=fs.readFileSync(source),first=await finish.image(version);assert.notEqual(first,source);assert.ok(fs.existsSync(first));assert.equal(await finish.image(version),first);assert.deepEqual(fs.readFileSync(source),before);const report=JSON.parse(fs.readFileSync(first.replace('.png','.report.json')));assert.equal(report.style,'black');assert.deepEqual(report.native_size,[745,1040]);assert.ok(report.source_sha256);store.updateDeck(deck.id,{border_settings:{style:'none',width_mm:0}});assert.equal(await finish.image(version),source);});
test('card overrides, inheritance and artwork-set settings resolve consistently across viewers and exports',async t=>{const {store,deck,card,version,finish,source}=setup(t);const original=deck.active_art_set_id;store.updateCard(card.id,{border_settings:{style:'none',width_mm:0}});assert.equal(await finish.image(version),source);const set=store.artSets.create(deck.id,{name:'White edition',mode:'copy'});store.updateDeck(deck.id,{border_settings:{style:'white',width_mm:2}});store.updateCard(card.id,{border_settings:{}});const white=await finish.image(version),entry=(await finish.entries([{...version,back_path:null,quantity:1,name:card.name}]))[0];assert.equal(entry.image_path,white);assert.equal(entry.original_image_path,source);store.artSets.activate(deck.id,original);assert.equal(await finish.image(version),source);store.artSets.activate(deck.id,set.id);assert.equal(await finish.image(version),white);});
test('official bordered and borderless versions bypass finishes on both faces and exports',async t=>{
 const {store,card,version,finish,source}=setup(t);
 store.updateCard(card.id,{border_settings:{style:'modern',width_mm:2.2}});
 for(const border_color of ['black','borderless']){
  const scan={...version,source_type:'official',summary:JSON.stringify({border_color,power:'2'}),faces_json:JSON.stringify([{label:'back',image_path:source}])};
  assert.deepEqual(finish.settings(scan),{style:'none',width_mm:0});
  assert.equal(await finish.image(scan,{settings:{style:'black',width_mm:2}}),source);
  assert.equal(await finish.image(scan,{back:true}),source);
  const exported=await finish.version(scan);assert.equal(exported.image_path,source);assert.equal(JSON.parse(exported.faces_json)[0].image_path,source);
 }
 // The same card's custom history still uses its explicit border preference.
 assert.notEqual(await finish.image(version),source);
});
test('JPEG and uppercase PNG sources are images, never mistaken for JSON reports',async t=>{
 const {source,version,finish}=setup(t);
 for(const suffix of ['jpg','PNG']){
  const image=source.replace('.png','.'+suffix);
  execFileSync('python3',['-c','from PIL import Image;import sys;Image.open(sys.argv[1]).save(sys.argv[2])',source,image]);
  const output=await finish.image({...version,image_path:image,summary:JSON.stringify({power:'2'})});
  assert.ok(fs.existsSync(output));assert.deepEqual(JSON.parse(fs.readFileSync(output.replace('.png','.report.json'))).native_size,[745,1040]);
 }
});
test('gallery thumbnails are bounded, preserve border choices, and never resize stored masters',async t=>{
 const {source,version,finish,store,deck}=setup(t),before=fs.readFileSync(source);
 const preview=await finish.image(version,{thumbnail:true});assert.match(preview,/\.thumb\.webp$/);assert.deepEqual(fs.readFileSync(source),before);const report=JSON.parse(fs.readFileSync(preview.replace('.webp','.report.json')));assert.ok(report.native_size[0]<=420);assert.equal(report.style,'black');
 const original=await finish.image({...version,source_type:'official'});assert.equal(original,source);const scanPreview=await finish.image({...version,source_type:'official'},{thumbnail:true});assert.notEqual(scanPreview,source);assert.equal(JSON.parse(fs.readFileSync(scanPreview.replace('.webp','.report.json'))).style,'none');
 store.updateDeck(deck.id,{border_settings:{style:'none',width_mm:0}});assert.notEqual(await finish.image(version,{thumbnail:true}),source);assert.equal(await finish.image(version),source);
});
