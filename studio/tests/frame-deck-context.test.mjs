import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../store.mjs';
import {FrameStudio} from '../frame-studio.mjs';
import {ArtStyles} from '../art-styles.mjs';

function setup(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frame-deck-')),store=new Store(directory),root=path.resolve('.');
 const queue={cooldownFor:()=>0},styles=new ArtStyles(store,root,queue,()=>{}),frames=new FrameStudio(store,root,queue,()=>{});
 queue.styleSnapshot=(deck,dir)=>styles.resolveDeck(deck,dir);frames.closed=true;
 t.after(()=>{styles.close();frames.close();store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const request=set=>JSON.parse(fs.readFileSync(path.join(set.versions[0].directory,'request.json'),'utf8'));
 const art=(card,label,extra={})=>{
  const dir=path.join(directory,label);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'art.png'),label);
  fs.writeFileSync(path.join(dir,'back.png'),label+' back');
  return store.addVersion(card.id,{image_path:path.join(dir,'art.png'),manifest_path:path.join(dir,'manifest.json'),summary:{art:'art.png',type_line:'Creature',...extra}});
 };
 return {store,styles,frames,request,art};
}

test('frame jobs snapshot inactive artwork-set style and selected face art, prioritizing commanders',t=>{
 const {store,styles,frames,request,art}=setup(t);
 const deck=store.createDeck({name:'Moonlit glass',style:'Violet glass and silver etching.'},[{name:'Soldier',quantity:1},{name:'Leader',quantity:1,section:'commander'},{name:'Scan',quantity:1}]);
 const cards=store.deck(deck.id).cards,leader=cards.find(c=>c.name==='Leader');
 const leaderVersion=art(leader,'leader',{faces:[{name:'Leader',art:'art.png'},{name:'Moon',art:'back.png'}]});
 art(cards.find(c=>c.name==='Soldier'),'soldier');const scan=art(cards.find(c=>c.name==='Scan'),'scan');store.run("UPDATE versions SET source_type='official' WHERE id=?",scan);
 const pinned=styles.list()[0].current_revision_id;styles.updateDeck(deck.id,{style_revision_id:pinned});
 const original=store.deck(deck.id).active_art_set_id;
 const other=store.artSets.create(deck.id,{name:'Hot steel',mode:'fresh',guidelines:'fresh',style:'Orange steel, no glass.'});
 const set=frames.create({name:'Lunar frame',brief:'Use delicate silver rails; keep panels dark.',deck_art_set_id:original});
 const req=request(set),context=req.deck_context;
 assert.equal(context.art_set_id,original);assert.equal(context.cards[0].id,leader.id);assert.equal(context.cards[0].version_id,leaderVersion);
 assert.equal(context.cards[0].art.length,2);assert.equal(context.illustrated_cards,2);assert.equal(context.cards.find(c=>c.name==='Scan').art.length,0);
 assert.match(context.style_text,/Violet glass/);assert.doesNotMatch(context.style_text,/Orange steel/);assert.equal(context.style_context.style_revision.id,pinned);
 assert.equal(fs.readFileSync(context.style_path,'utf8'),context.style_text);assert.equal(store.deck(deck.id).active_art_set_id,other.id);
 assert.equal(req.brief,'Use delicate silver rails; keep panels dark.');
 store.artSets.activate(deck.id,original);styles.updateDeck(deck.id,{custom_prompt:'A new theme.'});
 assert.equal(request(set).deck_context.style_text,context.style_text,'queued style remains frozen');
 assert.equal(request(set).deck_context.cards[0].version_id,leaderVersion);
 // Keep inspiration for revisions, or explicitly return to a standalone prompt.
 frames.update(set.id,{brief:'Refine the glass'});assert.equal(frames.detail(set.id).deck_art_set_id,original);
 frames.update(set.id,{deck_art_set_id:''});assert.equal(frames.detail(set.id).deck_art_set_id,'');
 store.run("UPDATE frame_versions SET status='failed' WHERE set_id=?",set.id);
 const revised=frames.generate(set.id,{});assert.equal(request(revised).deck_context,null);
});

test('standalone frames remain supported; unillustrated sets use guidelines; invalid sources create no frame',t=>{
 const {store,frames,request}=setup(t);
 const standalone=frames.create({name:'Standalone',brief:'Black iron.'});assert.equal(request(standalone).deck_context,null);
 const deck=store.createDeck({name:'No art yet',style:'Watercolour blue.'},[{name:'Leader',section:'commander',quantity:1}]);
 const themed=frames.create({name:'Water',brief:'Match this theme.',deck_art_set_id:deck.active_art_set_id});
 assert.equal(request(themed).deck_context.illustrated_cards,0);assert.match(request(themed).deck_context.style_text,/Watercolour blue/);
 const before=frames.list().length;assert.throws(()=>frames.create({name:'Bad',brief:'Bad source',deck_art_set_id:'missing'}),/existing deck artwork set/);assert.equal(frames.list().length,before);
 assert.throws(()=>frames.update(themed.id,{deck_art_set_id:'missing'}),/existing deck artwork set/);
});
