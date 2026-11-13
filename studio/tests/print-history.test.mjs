import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../store.mjs';
import {BorderFinish} from '../borders.mjs';
import {PrintHistory} from '../print-history.mjs';
import {printEntries,planPrint} from '../printing.mjs';

function setup(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'print-history-')),store=new Store(directory),borders=new BorderFinish(store,path.resolve('.')),history=new PrintHistory(store,borders);
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const deck=store.createDeck({name:'History'},[{name:'Sol Ring',quantity:2,section:'main'},{name:'Forest',quantity:1,section:'main'}]);
 for(const card of deck.cards){const source=path.join(directory,card.id+'.png');fs.writeFileSync(source,'original-image');store.addVersion(card.id,{image_path:source,summary:{name:card.name}});}
 const settings={packaging:'per_page',quality:'600',calibration:true};
 const current=(options=settings)=>{const resolved=printEntries(store,store.deck(deck.id),options);return {resolved,plan:planPrint(options,resolved.entries.reduce((sum,e)=>sum+e.quantity,0))};};
 const exportId='11111111-1111-4111-8111-111111111111';fs.mkdirSync(path.join(directory,'exports'));fs.writeFileSync(path.join(directory,'exports',exportId+'.zip'),'completed');
 return {directory,store,borders,history,deck,settings,current,exportId};
}

test('completed exports persist settings and match exactly across history instances',t=>{
 const {store,borders,history,settings,current,exportId}=setup(t),{resolved,plan}=current();
 history.remember(resolved,settings,plan,exportId);
 const reopened=new PrintHistory(store,borders),last=reopened.match(resolved,settings,plan);
 assert.equal(last.export_id,exportId);assert.equal(last.settings.quality,'600');assert.equal(last.settings.calibration,true);
 assert.equal(last.settings.paper,'A4');assert.equal(last.settings.page_range,'');
 assert.equal(reopened.match(resolved,settings,planPrint({...settings,quality:'compact'},3)),null);
});

test('history separates artwork sets, selections and pinned versions, and detects changed images, quantities and borders',t=>{
 const {store,history,deck,settings,current,exportId}=setup(t),original=current();history.remember(original.resolved,settings,original.plan,exportId);
 const selected=current({...settings,card_ids:[deck.cards[0].id]});assert.equal(history.latest(selected.resolved.print_scope),null);
 const firstSet=deck.active_art_set_id;store.artSets.create(deck.id,{name:'Copy',mode:'copy'});assert.equal(history.latest(current().resolved.print_scope),null);store.artSets.activate(deck.id,firstSet);
 store.updateCard(deck.cards[0].id,{quantity:3});let changed=current();assert.equal(history.match(changed.resolved,settings,changed.plan),null);store.updateCard(deck.cards[0].id,{quantity:2});
 store.updateDeck(deck.id,{border_settings:{style:'white',width_mm:2}});changed=current();assert.equal(history.match(changed.resolved,settings,changed.plan),null);
 store.updateDeck(deck.id,{border_settings:{style:'black',width_mm:1.2}});assert.ok(history.match(current().resolved,settings,current().plan));
 fs.appendFileSync(original.resolved.entries[0].image_path,'changed');changed=current();assert.equal(history.match(changed.resolved,settings,changed.plan),null);
});

test('a removed export is never offered as reusable',t=>{
 const {directory,history,settings,current,exportId}=setup(t),{resolved,plan}=current();history.remember(resolved,settings,plan,exportId);
 fs.unlinkSync(path.join(directory,'exports',exportId+'.zip'));assert.equal(history.match(resolved,settings,plan),null);
});
