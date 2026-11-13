import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Store} from '../store.mjs';import {planPrint,printEntries,printPageRange,printCount} from '../printing.mjs';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'print-selection-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});const deck=store.createDeck({name:'Print'},[{name:'Sol Ring',quantity:8,section:'main'},{name:'Forest',quantity:2,section:'sideboard'},{name:'Missing card',quantity:1,section:'main'}]),a=deck.cards.find(c=>c.name==='Sol Ring'),b=deck.cards.find(c=>c.name==='Forest');const old=store.addVersion(a.id,{image_path:path.join(dir,'old.png'),summary:{name:a.name},faces:[{label:'back',image_path:path.join(dir,'back.png')}]});const current=store.addVersion(a.id,{image_path:path.join(dir,'new.png'),summary:{name:a.name}});store.addVersion(b.id,{image_path:path.join(dir,'forest.png'),summary:{name:b.name}});return {store,deck:store.deck(deck.id),a,b,old,current,dir};}
test('single-card printing pins a chosen historical version, copies and backs without printing unrelated blank cards',t=>{
 const {store,deck,a,old,dir}=setup(t);const result=printEntries(store,deck,{card_ids:[a.id],version_id:old,copies:1,art_set_id:deck.active_art_set_id});assert.equal(result.entries.length,1);assert.deepEqual(result.missing,[]);assert.equal(result.entries[0].image_path,path.join(dir,'old.png'));assert.equal(result.entries[0].quantity,1);assert.equal(result.entries[0].back_path,path.join(dir,'back.png'));assert.equal(store.deck(deck.id).cards[0].quantity,8);const backs=printEntries(store,deck,{card_ids:[a.id],version_id:old,copies:3,face_mode:'backs'});assert.equal(backs.entries[0].image_path,path.join(dir,'back.png'));assert.equal(backs.entries[0].quantity,3);
});
test('multi-card selections include explicitly chosen sideboard cards and support deck quantities or one each',t=>{
 const {store,deck,a,b}=setup(t);assert.equal(printEntries(store,deck,{card_ids:[a.id,b.id],include_sideboard:false}).entries.reduce((n,c)=>n+c.quantity,0),10);assert.equal(printEntries(store,deck,{card_ids:[a.id,b.id],quantities:false}).entries.reduce((n,c)=>n+c.quantity,0),2);assert.deepEqual(printEntries(store,deck,{}).missing,['Missing card']);
});
test('printing validates scope, card ownership, versions, copy limits and artwork-set boundaries',t=>{
 const {store,deck,a,old}=setup(t),foreign=store.createDeck({name:'Other'},[{name:'Other card',quantity:1}]);for(const settings of [{card_ids:[]},{card_ids:[foreign.cards[0].id]},{card_ids:[a.id,a.id]},{card_ids:[a.id],copies:0},{card_ids:[a.id],copies:1.5},{card_ids:[a.id],copies:1000},{card_ids:[a.id],version_id:'wrong'},{version_id:old},{art_set_id:'wrong'}])assert.throws(()=>printEntries(store,deck,settings));store.artSets.create(deck.id,{name:'Fresh',mode:'fresh'});assert.throws(()=>printEntries(store,store.deck(deck.id),{card_ids:[a.id],version_id:old}),/artwork set/);
});
test('PDF page ranges select sorted, unique pages and validate against duplex and calibration page totals',()=>{
 assert.deepEqual(printPageRange('3, 1-2, 2',4),[1,2,3]);assert.equal(printPageRange('',5),null);for(const range of ['0','5','2-1','1,,2','abc','1.5'])assert.throws(()=>printPageRange(range,4));const plan=planPrint({face_mode:'duplex',calibration:true,page_range:'2, 5'},10);assert.equal(plan.total_pages,5);assert.equal(plan.output_pages,2);assert.deepEqual(plan.selected_pages,[2,5]);
});
test('print packaging defaults to a combined PDF and validates separate-page exports',()=>{
 assert.equal(planPrint({},10).packaging,'combined');
 assert.equal(planPrint({packaging:'per_page'},10).packaging,'per_page');
 for(const packaging of ['zip',true,''])assert.throws(()=>planPrint({packaging},10),/combined PDF/);
});

test('separate faces count each printed piece and retain page ranges and quantities',t=>{
 const {store,deck,a,old,b}=setup(t);
 const settings={card_ids:[a.id],version_id:old,copies:5,face_mode:'separate',calibration:true,page_range:'2,3'};
 const resolved=printEntries(store,deck,settings),count=printCount(resolved.entries,settings),plan=planPrint(settings,count);
 assert.equal(resolved.entries.length,1);assert.equal(resolved.entries[0].quantity,5);
 assert.equal(count,10);assert.equal(plan.pages,2);assert.equal(plan.total_pages,3);assert.deepEqual(plan.selected_pages,[2,3]);
 assert.equal(printCount(resolved.entries,{face_mode:'duplex'}),5);
 const mixed=[...resolved.entries,...printEntries(store,deck,{card_ids:[b.id],copies:2}).entries];
 assert.equal(printCount(mixed,settings),12);
 assert.equal(planPrint({face_mode:'separate'},1998).count,1998);
 assert.throws(()=>planPrint({face_mode:'separate'},2001));
 assert.equal(store.deck(deck.id).cards.find(c=>c.id===a.id).quantity,8);
});
